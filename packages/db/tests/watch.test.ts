import type { Bus } from 'db:core'
import { Db, DbBus, DbClient } from 'db:core'
import type { Operation } from 'std:effect'
import { run, sleep, useContext } from 'std:effect'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'
import { Transport } from 'transport:core'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { posts, users } from './helpers'

const bootstrap = function* (): Operation<AnyType> {
  yield* install(MemoryAdapter)
  yield* install(BunIO)
  return yield* install(DbClient, { tables: [users, posts] })
}

describe('reactivity — changes feed', () => {
  it('emits insert/update/delete events with monotonic versions', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const feed = yield* db.changes('users')

        const created = yield* db.insert('users', { name: 'ada' })
        yield* db.patch('users', String(created._id), { age: 36 })
        yield* db.delete('users', String(created._id))

        const first = yield* feed.next()
        expect(first.value).toMatchObject({
          table: 'users',
          op: 'insert',
          source: 'local',
        })
        expect('new' in (first.value as AnyType)).toBe(false)

        const second = yield* feed.next()
        expect(second.value).toMatchObject({ op: 'update', fields: ['age'] })

        const third = yield* feed.next()
        expect(third.value).toMatchObject({ op: 'delete' })
        expect(db.version('users')).toBe((third.value as AnyType).token)
      }),
    )
  })

  it('filters by table and leaves other feeds untouched', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const postsFeed = yield* db.changes('posts')
        const author = yield* db.insert('users', { name: 'ada' })
        yield* db.insert('posts', { title: 'notes', author: author._id })
        const step = yield* postsFeed.next()
        expect(step.value).toMatchObject({ table: 'posts', op: 'insert' })
      }),
    )
  })
})

describe('reactivity — query watch', () => {
  it('emits the current snapshot, then a fresh one per relevant change', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        yield* db.insert('users', { name: 'ada', age: 36, role: 'admin' })

        const snaps = yield* db.query('users').where({ role: 'admin' }).order('name').watch()

        const initial = yield* snaps.next()
        expect((initial.value as AnyType).rows.map((row: AnyType) => row.name)).toEqual(['ada'])

        yield* db.insert('users', { name: 'grace', role: 'admin' })
        const updated = yield* snaps.next()
        expect((updated.value as AnyType).rows.map((row: AnyType) => row.name)).toEqual([
          'ada',
          'grace',
        ])
        expect((updated.value as AnyType).token).toBe(db.version('users'))
      }),
    )
  })

  it('watches a single document until deletion', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const created = yield* db.insert('users', { name: 'ada' })
        const id = String(created._id)

        const docFeed = yield* db.watch('users', id)
        const initial = yield* docFeed.next()
        expect((initial.value as AnyType).name).toBe('ada')

        yield* db.patch('users', id, { age: 40 })
        const patched = yield* docFeed.next()
        expect((patched.value as AnyType).age).toBe(40)

        // a write to a DIFFERENT doc must not wake this watcher
        yield* db.insert('users', { name: 'grace' })
        yield* db.delete('users', id)
        const gone = yield* docFeed.next()
        expect(gone.value).toBeNull()
      }),
    )
  })
})

describe('reactivity — cross-node bus', () => {
  /** The bus over an in-process transport: the test records what this node ships through its
   * own subscription on the topic and injects what "peers" ship by publishing on it. */
  const makeBus = function* () {
    yield* install(MemoryTransport, { prefix: 'app', link: createLink() })
    const shipped = yield* Transport.actions.subscribe<Bus.Envelope>('db.change')
    yield* install(DbBus)
    const inject = (envelope: Bus.Envelope) => Transport.actions.publish('db.change', envelope)
    return { shipped, inject }
  }

  it('publishes local writes (id/op/fields/token) and surfaces foreign events (echoes dropped)', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const { shipped, inject } = yield* makeBus()

        // a bus installed AFTER the client is picked up by an explicit bridge (idempotent)
        expect(yield* Db.actions.bridge()).toBe(1)
        expect(yield* Db.actions.bridge()).toBe(0)
        expect((yield* useContext(DbBus)).transportName).toBe('memory')

        const ada = yield* db.insert('users', { name: 'ada' })
        yield* db.patch('users', ada._id, { age: 40 })
        // the outbox ships asynchronously
        const published = [
          ((yield* shipped.next()) as AnyType).value.value as Bus.Envelope,
          ((yield* shipped.next()) as AnyType).value.value as Bus.Envelope,
        ]
        const origin = (yield* Db.actions.bus()).origin
        expect(published[0]).toMatchObject({ origin, seq: 1 })
        expect(published[0]!.events[0]).toMatchObject({ table: 'users', id: ada._id, op: 'insert' })
        expect(published[0]!.events[0]!.token.endsWith(origin)).toBe(true)
        expect(published[1]).toMatchObject({ seq: 2 })
        expect(published[1]!.events[0]).toMatchObject({ op: 'update', fields: ['age'] })
        expect('new' in (published[1]!.events[0] as AnyType)).toBe(false)

        const feed = yield* db.changes('users')
        // own echo (same origin) must be dropped; a foreign envelope must surface
        yield* inject(published[0]!)
        const foreign = yield* IO.actions.hlc({ origin: 'NDEB0002' })
        yield* inject({
          origin: 'NDEB0002',
          seq: 1,
          tx: foreign,
          events: [{ table: 'users', id: 'remote-1', op: 'insert', token: foreign }],
        })
        const step = yield* feed.next()
        expect(step.value).toMatchObject({
          id: 'remote-1',
          op: 'insert',
          source: 'bus',
          token: foreign,
        })
        expect(db.version('users')).toBe(foreign)

        // the same envelope again is a duplicate; a later one with a hole is a gap → replay
        yield* inject({
          origin: 'NDEB0002',
          seq: 1,
          tx: foreign,
          events: [{ table: 'users', id: 'remote-1', op: 'insert', token: foreign }],
        })
        const third = yield* IO.actions.hlc({ origin: 'NDEB0002' })
        yield* inject({
          origin: 'NDEB0002',
          seq: 3,
          tx: third,
          events: [{ table: 'users', id: 'remote-3', op: 'insert', token: third }],
        })
        expect(((yield* feed.next()).value as AnyType).id).toBe('remote-3')
        yield* sleep(10)
        const stats = yield* Db.actions.busStats()
        // own echoes never reach the hub (dropped by origin before counting)
        expect(stats).toMatchObject({ published: 2, received: 3, deduped: 1, gaps: 2 })
        expect(stats.peers.NDEB0002?.seq).toBe(3)
      }),
    )
  })
})
