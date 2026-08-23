import type { Bus } from 'db:core'
import { column, Db, DbAdapter, DbBus, DbClient, DbErrors, table, withBusMeta } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, createQueue, fork, race, run, scoped, sleep } from 'std:effect'
import { useBufferedEvent } from 'std:event'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryAdapter } from 'db:impl/memory'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'
import { Transport } from 'transport:core'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { users } from './helpers'

describe('change bus', () => {
  it('the bus rides the installed transport: publish reaches every node on the topic', async () => {
    unwrap(
      await run(function* () {
        const link = createLink()
        yield* install(MemoryTransport, { prefix: 'app', link })
        yield* install(DbBus)
        const bus = yield* DbBus.actions.describe()
        expect(bus).toMatchObject({ transport: 'memory', topic: 'db.change' })
        const feed = yield* useBufferedEvent(bus.events, 'change')
        yield* DbBus.actions.publish({
          origin: 'NDEA0001',
          seq: 1,
          tx: 'T1',
          events: [{ table: 'users', id: '1', op: 'insert', token: 'T1' }],
        })
        yield* DbBus.actions.publish({
          origin: 'NDEA0001',
          seq: 2,
          tx: 'T2',
          events: [{ table: 'users', id: '2', op: 'insert', token: 'T2' }],
        })
        const first = yield* feed.next()
        const second = yield* feed.next()
        expect((first.value as AnyType)[0].events[0].id).toBe('1')
        expect((second.value as AnyType)[0].seq).toBe(2)
      }),
    )
  })

  it('a pinned transport and a custom topic; no transport at all → db.configuration', async () => {
    unwrap(
      await run(function* () {
        const missing = yield* attempt(install(DbBus))
        expect((missing as AnyType).error).toBe(DbErrors.Configuration)

        yield* install(MemoryTransport, { prefix: 'app' })
        yield* install(DbBus, { transport: MemoryTransport, topic: 'changes.users' })
        const heard = yield* Transport.actions.subscribe<Bus.Envelope>('changes.users')
        yield* DbBus.actions.publish({ origin: 'NDEA0001', seq: 1, tx: 'T1', events: [] })
        expect(((yield* heard.next()) as AnyType).value.value.seq).toBe(1)
      }),
    )
  })

  it('without any bus the local bus publishes into the void (single node)', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [users] })
        const bus = yield* Db.actions.bus()
        expect(typeof bus.origin).toBe('string')
        expect(yield* Db.actions.bridge()).toBe(0)
        yield* db.insert('users', { name: 'alone' })
        expect(yield* db.query('users').count()).toBe(1)
        yield* sleep(10)
        expect(yield* Db.actions.busStats()).toMatchObject({ published: 0, failed: 0 })
      }),
    )
  })

  it('a failing or slow transport never touches the write path; overflow drops, stats count', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        yield* install(MemoryTransport, { prefix: 'app' })
        yield* install(DbBus)
        // the transport goes away under the bus: every publish now fails
        yield* Transport.actions.drain()
        const db = yield* install(DbClient, { tables: [users], bus: { maxPending: 2 } })
        // writes succeed regardless of the transport
        yield* db.insert('users', { name: 'a' })
        yield* db.insert('users', { name: 'b' })
        yield* sleep(20)
        expect((yield* Db.actions.busStats()).failed).toBeGreaterThan(0)
        expect(yield* db.query('users').count()).toBe(2)
      }),
    )
  })

  it('options.id mints every document id; an invalid origin fails db.configuration', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        let counter = 0
        const db = yield* install(DbClient, {
          tables: [users],
          *id() {
            counter += 1
            return `custom-${counter}`
          },
        })
        const one = (yield* db.insert('users', { name: 'a' })) as AnyType
        const two = (yield* db.insert('users', { name: 'b' })) as AnyType
        // the install probes the minter once, then every document gets the next id
        expect([one._id, two._id]).toEqual(['custom-2', 'custom-3'])
        expect(counter).toBe(3)

        const bad = yield* attempt(install(DbClient, { tables: [users], origin: 'NODE-A' }))
        expect((bad as AnyType).error).toBe(DbErrors.Configuration)
      }),
    )
  })

  it('outbox: a slow carrier never delays writes; overflow coalesces; close drains the rest', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        yield* install(MemoryTransport, { prefix: 'app' })
        const shipped = yield* Transport.actions.subscribe<Bus.Envelope>('db.change')
        yield* install(DbBus)
        // every publish takes 30ms on the wire
        yield* Transport.around({
          publish: ([topic, value, options]: AnyType[], next: AnyType) =>
            (function* () {
              yield* sleep(30)
              return yield* next(topic, value, options)
            })(),
        })
        const stats = yield* scoped(function* () {
          const db = yield* install(DbClient, {
            tables: [users],
            bus: { maxPending: 2, drainTimeoutMs: 500 },
          })
          const started = Date.now()
          for (let n = 0; n < 6; n += 1) {
            yield* db.insert('users', { name: `u${n}` })
          }
          // six writes, none waited for the wire
          expect(Date.now() - started).toBeLessThan(30)
          yield* sleep(5)
          return yield* Db.actions.busStats()
        })
        // the outbox held at most 2: older envelopes were dropped (peers heal via the log)
        expect(stats.coalesced).toBeGreaterThan(0)
        // …and whatever was still queued when the scope closed got shipped before it ended
        const heard: number[] = []
        for (;;) {
          const step = yield* race([
            shipped.next(),
            (function* () {
              yield* sleep(100)
              return { done: true as const, value: undefined }
            })(),
          ])
          if ((step as AnyType).done) {
            break
          }
          heard.push((step as AnyType).value.value.seq)
        }
        expect(heard.length).toBeGreaterThanOrEqual(2)
        expect(heard.at(-1)).toBe(6)
      }),
    )
  })

  it('drift: a foreign token from far in the future is applied but counted as driftRejected', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        yield* install(MemoryTransport, { prefix: 'app' })
        yield* install(DbBus)
        const db = yield* install(DbClient, { tables: [users] })
        const feed = yield* db.changes('users')
        // a token minted by a clock 10 minutes ahead: Crockford(ms, 10) + counter(4) + origin(8)
        const encode = (value: number, length: number) => {
          const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
          let out = ''
          let rest = value
          for (let index = 0; index < length; index += 1) {
            out = alphabet[rest % 32]! + out
            rest = Math.floor(rest / 32)
          }
          return out
        }
        const ahead = `${encode(Date.now() + 10 * 60 * 1000, 10)}${encode(1, 4)}NDEB0002`
        expect((yield* IO.actions.decodeHlc(ahead)).origin).toBe('NDEB0002')
        yield* Transport.actions.publish('db.change', {
          origin: 'NDEB0002',
          seq: 1,
          tx: ahead,
          events: [{ table: 'users', id: 'future', op: 'insert', token: ahead }],
        })
        expect(((yield* feed.next()).value as AnyType).token).toBe(ahead)
        expect((yield* Db.actions.busStats()).driftRejected).toBe(1)
        // the local clock did not adopt it: a fresh local token stays behind the drifted one
        expect((yield* Db.actions.version()) < ahead).toBe(true)
      }),
    )
  })

  it('withBusMeta: correlation data rides the envelope; log:false tables keep no change log', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        yield* install(MemoryTransport, { prefix: 'app' })
        const shipped = yield* Transport.actions.subscribe<Bus.Envelope>('db.change')
        yield* install(DbBus)
        const scratch = table('scratch', { n: column.int() }, { log: false })
        const db = yield* install(DbClient, { tables: [users, scratch] })

        yield* withBusMeta({ requestId: 'req-1' }, () => db.insert('users', { name: 'ada' }))
        const envelope = ((yield* shipped.next()) as AnyType).value.value as Bus.Envelope
        expect(envelope.meta).toEqual({ requestId: 'req-1' })
        yield* db.insert('users', { name: 'bob' })
        expect(((yield* shipped.next()) as AnyType).value.value.meta).toBeUndefined()

        // a log-less table still announces (events + bus) but has no history
        const feed = yield* db.changes('scratch')
        yield* db.insert('scratch', { n: 1 })
        expect(((yield* feed.next()).value as AnyType).op).toBe('insert')
        expect(((yield* shipped.next()) as AnyType).value.value.events[0].table).toBe('scratch')
        const noLog = yield* attempt(Db.actions.log('scratch'))
        expect((noLog as AnyType).error).toBe(DbErrors.Validation)
        expect((yield* DbAdapter.actions.tables()).some(name => name === '__changes_scratch')).toBe(
          false,
        )
        // the planner never creates one for it either
        const plan = yield* Db.actions.planMigration()
        expect(plan.steps.some((step: AnyType) => step.table?.name === '__changes_scratch')).toBe(
          false,
        )
      }),
    )
  })

  it('polling: two nodes on one sqlite file talk through the change log with NO transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-db-poll-'))
    const path = join(dir, 'shared.sqlite')
    try {
      unwrap(
        await run(function* () {
          const ready = createQueue<void, void>()
          const listener = yield* fork(() =>
            scoped(function* () {
              yield* install(SqliteAdapter, { path })
              yield* install(BunIO)
              const db = yield* install(DbClient, {
                tables: [users],
                origin: 'NDEB0002',
                pollMs: 25,
              })
              const snaps = yield* db.query('users').watch()
              const feed = yield* db.changes('users')
              yield* snaps.next()
              ready.add(undefined)
              const snap = yield* snaps.next()
              // no transport: the change arrived from the log, and the counters say so
              expect(((yield* feed.next()).value as AnyType).source).toBe('replay')
              expect((yield* Db.actions.busStats()).replayed).toBeGreaterThanOrEqual(1)
              return (snap.value as AnyType).rows.map((row: AnyType) => row.name)
            }),
          )
          yield* ready.next()
          yield* scoped(function* () {
            yield* install(SqliteAdapter, { path })
            yield* install(BunIO)
            const db = yield* install(DbClient, { tables: [users], origin: 'NDEA0001' })
            yield* db.insert('users', { name: 'polled' })
          })
          expect(yield* listener).toEqual(['polled'])
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('two nodes over a shared sqlite file: writes on one wake watchers on the other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-db-bus-'))
    const path = join(dir, 'shared.sqlite')
    const link = createLink()

    let release: () => void = () => {}
    const nodeBReady = new Promise<void>(resolve => {
      release = resolve
    })

    const nodeOf = function* (origin: string): Operation<AnyType> {
      yield* install(SqliteAdapter, { path })
      yield* install(BunIO)
      yield* install(MemoryTransport, { prefix: 'app', link })
      yield* install(DbBus)
      const db = yield* install(DbClient, { tables: [users], origin })
      return db
    }

    try {
      const nodeB = run(function* () {
        const db = yield* nodeOf('NDEB0002')
        const feed = yield* db.changes('users')
        const snaps = yield* db.query('users').watch()
        yield* snaps.next()
        release()

        // the first envelope from a never-seen peer triggers a replay of its change log, so the
        // foreign write surfaces from the log (`replay`) — identity + token only, then re-read
        const event = yield* feed.next()
        expect(event.value).toMatchObject({ op: 'insert' })
        expect(['bus', 'replay']).toContain((event.value as AnyType).source)
        expect('new' in (event.value as AnyType)).toBe(false)
        expect((event.value as AnyType).token.endsWith('NDEA0001')).toBe(true)
        const snap = yield* snaps.next()
        return (snap.value as AnyType).rows.map((row: AnyType) => row.name)
      })

      await nodeBReady
      const writer = run(function* () {
        const db = yield* nodeOf('NDEA0001')
        expect((yield* Db.actions.bus()).origin).toBe('NDEA0001')
        yield* db.insert('users', { name: 'remote-ada' })
      })
      unwrap(await writer)

      const names = unwrap(await nodeB)
      expect(names).toEqual(['remote-ada'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
