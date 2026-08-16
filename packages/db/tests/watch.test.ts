import type { AdapterDef, BusEvent, LiveChange } from 'db:core'
import { adapterDefaults, Db, DbAdapter, DbClient } from 'db:core'
import type { Operation } from 'std:effect'
import { createChannel, createSignal, operation, run } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'

import { posts, users } from './helpers'

const bootstrap = function* (): Operation<AnyType> {
  yield* install(MemoryAdapter)
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
          version: 1,
          source: 'local',
        })
        expect((first.value as AnyType).doc.name).toBe('ada')

        const second = yield* feed.next()
        expect(second.value).toMatchObject({ op: 'update', version: 2 })

        const third = yield* feed.next()
        expect(third.value).toMatchObject({ op: 'delete', version: 3 })
        expect(db.version('users')).toBe(3)
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
        expect((updated.value as AnyType).version).toBe(db.version('users'))
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
  const makeBus = (origin: string) => {
    const events = createSignal<BusEvent, never>()
    const published: BusEvent[] = []
    return {
      origin,
      publish: operation(function* (batch: readonly BusEvent[]) {
        published.push(...batch)
      }),
      events,
      published,
    }
  }

  it('publishes local writes and surfaces foreign events (echoes dropped)', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const bus = makeBus('node-a')

        expect(yield* Db.actions.hasBus()).toBe(false)
        expect(yield* Db.actions.connectBus(bus)).toBe(true)
        expect(yield* Db.actions.connectBus(bus)).toBe(false)
        expect(yield* Db.actions.hasBus()).toBe(true)

        yield* db.insert('users', { name: 'ada' })
        expect(bus.published).toHaveLength(1)
        expect(bus.published[0]).toMatchObject({ table: 'users', op: 'insert', origin: 'node-a' })

        const feed = yield* db.changes('users')
        // own echo (origin node-a) must be dropped; foreign event must surface
        bus.events.send({ ...bus.published[0]!, origin: 'node-a' })
        bus.events.send({
          table: 'users',
          id: 'remote-1',
          op: 'insert',
          version: 9,
          origin: 'node-b',
        })
        const step = yield* feed.next()
        expect(step.value).toMatchObject({ id: 'remote-1', source: 'bus', version: 9 })
        expect(db.version('users')).toBe(9)
      }),
    )
  })
})

describe('reactivity — native live feed', () => {
  const makeLiveAdapter = () => {
    const liveChannel = createChannel<LiveChange, void>()
    const adapter = DbAdapter.implement<AdapterDef.Info, []>({
      name: 'fake-live',
      version: '0.0.0',
      *setup() {
        return {
          adapter: 'fake-live',
          capabilities: { transactions: false, live: true, raw: false },
        }
      },
    }).build({
      ...adapterDefaults('fake-live'),
      find: operation(function* () {
        return []
      }),
      count: operation(function* () {
        return 0
      }),
      insert: operation(function* (_table: AnyType, rows: AnyType) {
        return rows
      }),
      update: operation(function* () {
        return []
      }),
      remove: operation(function* () {
        return []
      }),
      introspect: operation(function* () {
        return { columns: [] }
      }),
      migrate: operation(function* () {}),
      live: operation(function* () {
        return liveChannel
      }),
    })
    return { adapter, liveChannel }
  }

  it('the live feed owns the change stream — local writes are not double-emitted', async () => {
    const { adapter: FakeLiveAdapter, liveChannel } = makeLiveAdapter()
    unwrap(
      await run(function* () {
        yield* install(FakeLiveAdapter)
        const db = yield* install(DbClient, { tables: [users] })
        const feed = yield* db.changes('users')

        // a local write reaches the backend, but the hub does NOT synthesize an event for it
        yield* db.insert('users', { name: 'ada' })

        // …the backend's live feed is the single source of truth (external writes included)
        yield* liveChannel.send({
          table: 'users',
          id: 'ext-1',
          op: 'insert',
          doc: { _id: 'ext-1', name: 'external' },
        })
        const step = yield* feed.next()
        expect(step.value).toMatchObject({ id: 'ext-1', source: 'live', version: 1 })
      }),
    )
  })

  it('a dying feed degrades to write-through instead of killing reactivity', async () => {
    const { adapter: FakeLiveAdapter, liveChannel } = makeLiveAdapter()
    unwrap(
      await run(function* () {
        yield* install(FakeLiveAdapter)
        const db = yield* install(DbClient, { tables: [users] })
        const feed = yield* db.changes('users')

        // the backend feed dies (reconnect budget exhausted, upstream gone, …)
        yield* liveChannel.close(undefined)

        // the hub falls back: a healing table-level touch, then local writes emit again
        const heal = yield* feed.next()
        expect(heal.value).toMatchObject({ op: 'touch', id: '', source: 'local' })

        yield* db.insert('users', { name: 'ada' })
        const local = yield* feed.next()
        expect(local.value).toMatchObject({ op: 'insert', source: 'local' })
        expect((local.value as AnyType).doc.name).toBe('ada')
      }),
    )
  })
})
