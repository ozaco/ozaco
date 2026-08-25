import type { Change, Database, Schema, Spec } from 'db:core'
import { Db, DbBus, DbClient } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, createQueue, fork, run, scoped, sleep, withResolvers } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'
import type { Memory } from 'transport:impl/memory'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { users } from './helpers'

/**
 * The invariant suite: three nodes share one sqlite file and hear each other ONLY through the
 * bus over a chaos memory link that delays, reorders, duplicates and drops envelopes (seeded). A
 * driver fires random
 * writes at random nodes; once the network settles, every node must agree with the database and
 * with every other node. `DB_CHAOS_SEEDS` widens the sweep (the plan's gate is 200).
 */

const SEEDS = Number(process.env.DB_CHAOS_SEEDS ?? 6)
const STEPS = 24
const ORIGINS = ['NDEA0001', 'NDEB0002', 'NDEC0003'] as const
const POLL_MS = 40
const MAX_DELAY_MS = 40
const REPLAY_WINDOW_MS = 2000

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Handle = Database.Handle<Schema.From<[typeof users]>>

interface Task {
  readonly body: (db: Handle) => Operation<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

interface Node {
  readonly origin: string
  /** run `body` with the node's handle, inside the node's scope. */
  exec<T>(body: (db: Handle) => Operation<T>): Operation<T>
  /** every event the node's hub emitted for `users`, in arrival order. */
  readonly events: Change.Event[]
  /** the rows of the node's latest snapshot emission. */
  last(): readonly Spec.Doc[]
  stop(): void
}

/** Boot one node in its own scope and hand back a remote control for it. */
function* spawnNode(origin: string, path: string, link: Memory.Link): Operation<Node> {
  const tasks = createQueue<Task, void>()
  const ready = withResolvers<void>()
  const events: Change.Event[] = []
  let last: readonly Spec.Doc[] = []

  yield* fork(() =>
    scoped(function* () {
      yield* install(SqliteAdapter, { path })
      yield* install(BunIO)
      yield* install(MemoryTransport, { prefix: 'chaos', link })
      yield* install(DbBus)
      const db = yield* install(DbClient, {
        tables: [users],
        origin,
        pollMs: POLL_MS,
        replayWindowMs: REPLAY_WINDOW_MS,
      })
      yield* fork(function* () {
        const feed = yield* db.changes('users')
        for (;;) {
          const next = yield* feed.next()
          events.push(next.value)
        }
      })
      yield* fork(function* () {
        const snapshots = yield* db.query('users').watch()
        for (;;) {
          const next = yield* snapshots.next()
          last = (next.value as Change.Snapshot).rows
        }
      })
      ready.resolve()
      for (;;) {
        const item = yield* tasks.next()
        if (item.done) {
          return
        }
        const outcome = yield* attempt(() => item.value.body(db))
        if (isFailure(outcome)) {
          item.value.reject(outcome)
        } else {
          item.value.resolve(outcome.value)
        }
      }
    }),
  )
  yield* ready.operation

  return {
    origin,
    events,
    last: () => last,
    stop: () => tasks.close(undefined),
    *exec<T>(body: (db: Handle) => Operation<T>) {
      const settled = withResolvers<T>()
      tasks.add({
        body,
        resolve: value => settled.resolve(value as T),
        reject: error => settled.reject(error),
      })
      return yield* settled.operation
    },
  }
}

const OPS = ['insert', 'patch', 'delete', 'tx', 'touch', 'raw', 'publish', 'compact'] as const

interface World {
  readonly random: () => number
  readonly nodes: readonly Node[]
  /** the ids that exist right now (insert/delete keep it current). */
  readonly ids: string[]
}

/** One random write on one random node. */
function* step(world: World, label: string): Operation<void> {
  const { random, nodes, ids } = world
  const node = nodes[Math.floor(random() * nodes.length)]!
  const pick = (): string | undefined => ids[Math.floor(random() * ids.length)]
  const op = ids.length === 0 ? 'insert' : OPS[Math.floor(random() * OPS.length)]!
  const age = Math.floor(random() * 100)
  switch (op) {
    case 'insert': {
      const doc = yield* node.exec(db => db.insert('users', { name: `u-${label}`, age }))
      ids.push(String(doc._id))
      return
    }
    case 'patch': {
      yield* node.exec(db => db.patch('users', pick()!, { age }))
      return
    }
    case 'delete': {
      const id = pick()!
      yield* node.exec(db => db.delete('users', id))
      ids.splice(ids.indexOf(id), 1)
      return
    }
    case 'tx': {
      const doc = yield* node.exec(db =>
        db.transaction(function* (tx) {
          const inserted = yield* tx.insert('users', { name: `t-${label}`, age })
          yield* tx.patch('users', pick()!, { age: age + 1 })
          return inserted
        }),
      )
      ids.push(String(doc._id))
      return
    }
    case 'touch': {
      const id = pick()!
      yield* node.exec(() => Db.actions.touch('users', id))
      return
    }
    case 'raw': {
      const id = pick()!
      yield* node.exec(() =>
        Db.actions.raw('UPDATE "users" SET "age" = ? WHERE "_id" = ? RETURNING "_id"', [age, id], {
          table: 'users',
          emit: { op: 'update', fields: ['age'] },
        }),
      )
      return
    }
    case 'publish': {
      const id = pick()!
      yield* node.exec(() =>
        Db.actions.publish([{ table: 'users', id, op: 'update', fields: ['age'] }]),
      )
      return
    }
    case 'compact': {
      // a sane compaction never reaches into the replay horizon peers may still need
      yield* node.exec(() => Db.actions.compact('users', { before: new Date(Date.now() - 60_000) }))
      return
    }
    default: {
      return
    }
  }
}

const byId = (rows: readonly Spec.Doc[]) =>
  rows.toSorted((left, right) => String(left._id).localeCompare(String(right._id)))

function* chaos(seed: number): Operation<void> {
  const dir = mkdtempSync(join(tmpdir(), `ozaco-db-chaos-${seed}-`))
  const path = join(dir, 'shared.sqlite')
  const link = createLink({ chaos: { seed, maxDelayMs: MAX_DELAY_MS } })
  const random = mulberry32(seed * 7919 + 17)
  try {
    yield* scoped(function* () {
      const nodes: Node[] = []
      for (const origin of ORIGINS) {
        nodes.push(yield* spawnNode(origin, path, link))
      }
      const world: World = { random, nodes, ids: [] }
      for (let index = 0; index < STEPS; index += 1) {
        yield* step(world, `${seed}-${index}`)
        if (random() < 0.3) {
          yield* sleep(Math.floor(random() * 10))
        }
      }
      // the network settles: in-flight deliveries land, the last poll heals whatever was dropped
      yield* sleep(MAX_DELAY_MS + POLL_MS * 3 + 50)

      const truth = byId(yield* nodes[0]!.exec(db => db.query('users').collect()))
      const local = nodes.flatMap(node => node.events.filter(event => event.source === 'local'))
      const every = new Set(local.map(event => event.token))
      const stats = yield* nodes[0]!.exec(() => Db.actions.busStats())
      const network = link.chaos!.counters
      const detail = { seed, stats, network, writes: every.size }

      // the network misbehaved for real
      expect(network.dropped + network.duplicated, `${seed}: no chaos`).toBeGreaterThan(0)
      // every write was minted exactly once, somewhere
      expect(local.length, `${seed}: one token per write`).toBe(every.size)
      for (const node of nodes) {
        const tokens = node.events.map(event => event.token)
        // no change applied twice: envelope, duplicate, replay and poll all dedupe
        expect(
          new Set(tokens).size,
          `${node.origin} applied a token twice ${JSON.stringify(detail)}`,
        ).toBe(tokens.length)
        // no starvation: every write reached every node (own writes, envelopes, or the log)
        expect(new Set(tokens), `${node.origin} missed writes ${JSON.stringify(detail)}`).toEqual(
          every,
        )
        // the watcher converged on the database
        expect(byId(node.last()), `${node.origin} snapshot ≠ db ${JSON.stringify(detail)}`).toEqual(
          truth,
        )
        // version(table) is the last token the node applied
        const version = yield* node.exec(function* (db) {
          return db.version('users')
        })
        expect(version).toBe(tokens.at(-1)!)
      }
      // every live row's version was announced (raw emit stamps, touch re-versions, …)
      for (const row of truth) {
        expect(
          every.has(String(row._version)),
          `${seed}: row ${row._id} carries an unannounced version`,
        ).toBe(true)
      }
      // the change log holds exactly the announced writes (nothing compacted in this horizon)
      const log = yield* nodes[0]!.exec(() => Db.actions.log('users', { limit: 10_000 }))
      expect(new Set(log.map(entry => entry.token))).toEqual(every)
      // the counters hang together
      for (const node of nodes) {
        const counters = yield* node.exec(() => Db.actions.busStats())
        expect(counters.received).toBeGreaterThanOrEqual(counters.deduped + counters.gaps)
        expect(counters.failed).toBe(0)
        expect(counters.driftRejected).toBe(0)
      }
      // `since: token` never skips a change that happened after it
      const olderThanLast = local.at(-2)
      if (olderThanLast) {
        const resumed = yield* nodes[1]!.exec(function* (db) {
          const flow = yield* db.query('users').watch({ since: olderThanLast.token })
          const first = yield* flow.next()
          return (first.value as Change.Snapshot).rows
        })
        expect(byId(resumed)).toEqual(truth)
      }
      for (const node of nodes) {
        node.stop()
      }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('chaos bus — invariants under delay/reorder/duplicate/drop', () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    it(`seed ${seed}`, async () => {
      unwrap(await run(() => chaos(seed)))
    })
  }
})
