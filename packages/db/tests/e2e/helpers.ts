import { Db, DbClient, DbErrors, gt, ilike, like, notNull, oneOf, or, useAdapter } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, run, scoped, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { posts, users } from '../helpers'

/** One database+driver binding under end-to-end test. */
export interface AdapterTarget {
  /** Must equal the adapter's `info.adapter` name. */
  readonly label: string
  /** false → the whole suite is skipped (e.g. no live server configured). */
  readonly enabled: boolean
  /** Whether the adapter declares the `raw` capability. */
  readonly raw: boolean
  /** Whether the adapter opens a native live feed (changes then arrive with source 'live'). */
  readonly live: boolean
  /** Install a FRESH backend into the current scope. */
  readonly install: () => Operation<unknown>
}

/**
 * The full-surface end-to-end suite every adapter must pass: writes, queries, pagination,
 * the reactive plane (changes / query watch / doc watch), transactions with event buffering,
 * the management plane and scope-teardown behavior. Tables are dropped and re-migrated per test,
 * so the suite is safe on shared servers too.
 */
export const runAdapterSuite = (target: AdapterTarget): void => {
  const bootstrap = function* (): Operation<AnyType> {
    yield* target.install()
    const db = yield* install(DbClient, { tables: [users, posts], migrations: 'manual' })
    yield* Db.actions.dropTable('posts')
    yield* Db.actions.dropTable('users')
    yield* Db.actions.migrate()
    return db
  }

  describe.skipIf(!target.enabled)(`e2e — ${target.label}`, () => {
    it('reports adapter info and capabilities', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            yield* bootstrap()
            const info = yield* useAdapter()
            expect(info.adapter).toBe(target.label)
            expect(info.capabilities.transactions).toBe(true)
            expect(info.capabilities.raw).toBe(target.raw)
            expect(info.capabilities.live).toBe(target.live)
          }),
        ),
      )
    })

    it('insert stamps system fields, applies defaults, strips unknown keys', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const doc = yield* db.insert('users', { name: 'ada', age: 36, junk: 'nope' })
            expect(typeof doc._id).toBe('string')
            expect(typeof doc._createdAt).toBe('number')
            expect(doc._version).toBe(1)
            expect(doc._updatedAt).toBe(doc._createdAt)
            expect(doc.role).toBe('member')
            expect(doc.active).toBe(true)
            expect(doc.meta).toBeNull()
            expect('junk' in doc).toBe(false)
          }),
        ),
      )
    })

    it('rejects invalid writes with db.validation', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const missing = yield* attempt(db.insert('users', {}))
            expect((missing as AnyType).error).toBe(DbErrors.Validation)
            const fraction = yield* attempt(db.insert('users', { name: 'x', age: 1.5 }))
            expect((fraction as AnyType).error).toBe(DbErrors.Validation)
            const badEnum = yield* attempt(db.insert('users', { name: 'x', role: 'boss' }))
            expect((badEnum as AnyType).error).toBe(DbErrors.Validation)
            const badTable = yield* attempt(db.insert('ghosts', { name: 'x' }))
            expect((badTable as AnyType).error).toBe(DbErrors.Validation)
            const created = yield* db.insert('users', { name: 'ok' })
            const nulled = yield* attempt(db.patch('users', String(created._id), { name: null }))
            expect((nulled as AnyType).error).toBe(DbErrors.Validation)
          }),
        ),
      )
    })

    it('get / patch / replace / delete lifecycle with version bumps', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const created = yield* db.insert('users', { name: 'ada', age: 36 })
            const id = String(created._id)

            const loaded = yield* db.get('users', id)
            expect(loaded?.name).toBe('ada')

            yield* sleep(2)
            const patched = yield* db.patch('users', id, { age: 37 })
            expect(patched?.age).toBe(37)
            expect(patched?._version).toBe(2)
            expect(Number(patched?._updatedAt)).toBeGreaterThan(Number(created._createdAt))

            const replaced = yield* db.replace('users', id, { name: 'lovelace' })
            expect(replaced?.name).toBe('lovelace')
            expect(replaced?.age).toBeNull()
            expect(replaced?._version).toBe(3)

            expect(yield* db.delete('users', id)).toBe(true)
            expect(yield* db.get('users', id)).toBeNull()
            expect(yield* db.delete('users', id)).toBe(false)
            expect(yield* db.patch('users', id, { age: 1 })).toBeNull()
          }),
        ),
      )
    })

    it('round-trips boolean, json, timestamp, enum and reference values', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const joined = new Date('2021-01-02T03:04:05.678Z')
            const author = yield* db.insert('users', {
              name: 'ada',
              role: 'admin',
              active: false,
              meta: { tags: ['a', 'b'] },
              joined,
            })
            expect(author.role).toBe('admin')
            expect(author.active).toBe(false)
            expect(author.meta).toEqual({ tags: ['a', 'b'] })
            expect(author.joined).toEqual(joined)

            const post = yield* db.insert('posts', { title: 'notes', author: author._id })
            expect(post.author).toBe(author._id)
            expect(post.views).toBe(0)

            const found = yield* db.query('users').where({ active: false }).first()
            expect((found as AnyType).name).toBe('ada')
          }),
        ),
      )
    })

    it('query surface: filters, order, take, first, unique, count, exists', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            yield* db.insert('users', { name: 'ada', age: 36, role: 'admin' })
            yield* db.insert('users', { name: 'grace', age: 45, role: 'admin' })
            yield* db.insert('users', { name: 'linus', age: 25 })
            yield* db.insert('users', { name: 'margaret' })

            const admins = yield* db.query('users').where({ role: 'admin' }).order('name').collect()
            expect(admins.map((row: AnyType) => row.name)).toEqual(['ada', 'grace'])

            const seniors = yield* db
              .query('users')
              .filter(gt('age', 30))
              .order('age', 'desc')
              .collect()
            expect(seniors.map((row: AnyType) => row.name)).toEqual(['grace', 'ada'])

            const g = yield* db.query('users').filter(like('name', 'g%')).collect()
            expect(g.map((row: AnyType) => row.name)).toEqual(['grace'])

            const caseless = yield* db.query('users').filter(ilike('name', 'ADA')).collect()
            expect(caseless.map((row: AnyType) => row.name)).toEqual(['ada'])

            const pair = yield* db
              .query('users')
              .filter(oneOf('name', ['ada', 'linus']))
              .order('name')
              .collect()
            expect(pair.map((row: AnyType) => row.name)).toEqual(['ada', 'linus'])

            const mixed = yield* db
              .query('users')
              .filter(or(like('name', 'mar%'), gt('age', 40)))
              .order('name')
              .collect()
            expect(mixed.map((row: AnyType) => row.name)).toEqual(['grace', 'margaret'])

            expect(yield* db.query('users').filter(notNull('age')).count()).toBe(3)
            expect((yield* db.query('users').order('name').take(2)).length).toBe(2)

            const single = yield* db.query('users').where({ name: 'ada' }).unique()
            expect((single as AnyType).age).toBe(36)
            const many = yield* attempt(db.query('users').where({ role: 'admin' }).unique())
            expect((many as AnyType).error).toBe(DbErrors.DataIntegrity)

            expect(yield* db.query('users').where({ name: 'ada' }).exists()).toBe(true)
            expect(yield* db.query('users').where({ name: 'zzz' }).exists()).toBe(false)

            const unknown = yield* attempt(db.query('users').where({ ghost: 1 }).collect())
            expect((unknown as AnyType).error).toBe(DbErrors.Validation)
          }),
        ),
      )
    })

    it('keyset pagination forward and backward', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            for (const [name, age] of [
              ['a', 1],
              ['b', 2],
              ['c', 3],
              ['d', 4],
              ['e', 5],
            ] as const) {
              yield* db.insert('users', { name, age })
            }

            const query = () => db.query('users').order('age')
            const pageOne = yield* query().paginate({ limit: 2 })
            expect(pageOne.data.map((row: AnyType) => row.name)).toEqual(['a', 'b'])
            expect(pageOne.pageInfo.hasNext).toBe(true)
            expect(pageOne.pageInfo.hasPrev).toBe(false)

            const pageTwo = yield* query().paginate({
              limit: 2,
              cursor: pageOne.pageInfo.nextCursor,
            })
            expect(pageTwo.data.map((row: AnyType) => row.name)).toEqual(['c', 'd'])

            const pageThree = yield* query().paginate({
              limit: 2,
              cursor: pageTwo.pageInfo.nextCursor,
            })
            expect(pageThree.data.map((row: AnyType) => row.name)).toEqual(['e'])
            expect(pageThree.pageInfo.hasNext).toBe(false)

            const counted = yield* query().paginate({ limit: 2, count: true })
            expect(counted.total).toBe(5)
            expect(pageOne.total).toBeUndefined()

            const back = yield* query().paginate({
              limit: 2,
              cursor: pageTwo.pageInfo.prevCursor,
              direction: 'backward',
            })
            expect(back.data.map((row: AnyType) => row.name)).toEqual(['a', 'b'])

            const garbage = yield* attempt(query().paginate({ limit: 2, cursor: '???' }))
            expect((garbage as AnyType).error).toBe(DbErrors.Cursor)
          }),
        ),
      )
    })

    it('maps unique-index violations to db.unique', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            yield* db.insert('users', { name: 'dup' })
            const outcome = yield* attempt(db.insert('users', { name: 'dup' }))
            expect(isFailure(outcome)).toBe(true)
            expect((outcome as AnyType).error).toBe(DbErrors.Unique)
          }),
        ),
      )
    })

    it('reactive: changes feed carries op/doc/version and filters by table', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const usersFeed = yield* db.changes('users')
            const postsFeed = yield* db.changes('posts')

            const created = yield* db.insert('users', { name: 'ada' })
            yield* db.insert('posts', { title: 'notes', author: created._id })
            yield* db.patch('users', String(created._id), { age: 36 })
            yield* db.delete('users', String(created._id))

            const first = yield* usersFeed.next()
            expect(first.value).toMatchObject({
              table: 'users',
              op: 'insert',
              version: 1,
              source: target.live ? 'live' : 'local',
            })
            expect((first.value as AnyType).doc.name).toBe('ada')

            const second = yield* usersFeed.next()
            expect(second.value).toMatchObject({ op: 'update' })
            expect((second.value as AnyType).doc.age).toBe(36)

            const third = yield* usersFeed.next()
            expect(third.value).toMatchObject({ op: 'delete' })

            const postEvent = yield* postsFeed.next()
            expect(postEvent.value).toMatchObject({ table: 'posts', op: 'insert', version: 1 })
            expect(db.version('users')).toBe(3)
            expect(db.version('posts')).toBe(1)
          }),
        ),
      )
    })

    it('reactive: query watch and doc watch re-emit on relevant changes', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            yield* db.insert('users', { name: 'ada', role: 'admin' })

            const snaps = yield* db.query('users').where({ role: 'admin' }).order('name').watch()
            const initial = yield* snaps.next()
            expect((initial.value as AnyType).rows.map((row: AnyType) => row.name)).toEqual(['ada'])

            yield* db.insert('users', { name: 'grace', role: 'admin' })
            const updated = yield* snaps.next()
            expect((updated.value as AnyType).rows.map((row: AnyType) => row.name)).toEqual([
              'ada',
              'grace',
            ])
            // the emitted version is what the snapshot REFLECTS (monotonic, usable as `since`); with an
            // async feed it may lag the very latest hub version
            expect((updated.value as AnyType).version).toBeGreaterThan(
              (initial.value as AnyType).version,
            )
            expect((updated.value as AnyType).version).toBeLessThanOrEqual(db.version('users'))

            const created = yield* db.insert('users', { name: 'watched' })
            const id = String(created._id)
            const docFeed = yield* db.watch('users', id)
            const current = yield* docFeed.next()
            expect((current.value as AnyType).name).toBe('watched')

            yield* db.patch('users', id, { age: 1 })
            const patched = yield* docFeed.next()
            expect((patched.value as AnyType).age).toBe(1)

            yield* db.delete('users', id)
            const gone = yield* docFeed.next()
            expect(gone.value).toBeNull()
          }),
        ),
      )
    })

    it('transactions: commit flushes buffered events, rollback emits nothing, savepoints nest', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const feed = yield* db.changes('users')

            yield* db.transaction(function* (tx: AnyType) {
              yield* tx.insert('users', { name: 'ada' })
              yield* tx.insert('users', { name: 'grace' })
            })
            expect(yield* db.query('users').count()).toBe(2)
            expect(((yield* feed.next()).value as AnyType).doc.name).toBe('ada')
            expect(((yield* feed.next()).value as AnyType).doc.name).toBe('grace')

            const outcome = yield* attempt(
              db.transaction(function* (tx: AnyType) {
                yield* tx.insert('users', { name: 'doomed' })
                return yield* fail(DbErrors.Query, 'boom')
              }),
            )
            expect(isFailure(outcome)).toBe(true)
            expect(yield* db.query('users').count()).toBe(2)

            yield* db.transaction(function* (tx: AnyType) {
              yield* tx.insert('users', { name: 'outer' })
              const inner = yield* attempt(
                tx.transaction(function* (nested: AnyType) {
                  yield* nested.insert('users', { name: 'inner' })
                  return yield* fail(DbErrors.Query, 'inner boom')
                }),
              )
              expect(isFailure(inner)).toBe(true)
            })
            const names = yield* db.query('users').order('name').collect()
            expect(names.map((row: AnyType) => row.name)).toEqual(['ada', 'grace', 'outer'])

            // rolled-back writes never reached the feed: the next event is the outer insert
            expect(((yield* feed.next()).value as AnyType).doc.name).toBe('outer')
          }),
        ),
      )
    })

    it('management plane: plan, reindex, dropIndex, dropTable', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            yield* db.insert('users', { name: 'ada' })

            const plan = yield* Db.actions.planMigration()
            const structural = plan.steps.filter((step: AnyType) => step.kind !== 'create-index')
            expect(structural).toEqual([])

            yield* Db.actions.reindex('users')
            yield* Db.actions.dropIndex('users', 'by_name')
            yield* db.insert('users', { name: 'ada' })
            expect(yield* db.query('users').count()).toBe(2)

            yield* Db.actions.dropTable('users')
            const after = yield* attempt(db.query('users').collect())
            expect(isFailure(after)).toBe(true)
          }),
        ),
      )
    })

    it(`raw escape hatch is ${target.raw ? 'available' : 'cleanly unsupported'}`, async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const joined = new Date('2021-01-02T03:04:05.678Z')
            yield* db.insert('users', {
              name: 'ada',
              age: 36,
              active: false,
              meta: { tags: ['x'] },
              joined,
            })
            const placeholder = target.label === 'sqlite' ? '?' : '$1'
            const outcome = yield* attempt(
              Db.actions.raw(`SELECT "name" FROM "users" WHERE "age" > ${placeholder}`, [30]),
            )
            if (!target.raw) {
              expect((outcome as AnyType).error).toBe(DbErrors.Unsupported)
              return
            }
            expect(isFailure(outcome)).toBe(false)
            expect((outcome as AnyType).value.rows).toEqual([{ name: 'ada' }])

            // Date params are normalized to the storage encoding
            const byDate = yield* Db.actions.raw(
              `SELECT "name" FROM "users" WHERE "joined" = ${placeholder}`,
              [joined],
            )
            expect(byDate.rows).toEqual([{ name: 'ada' }])

            // { table } decodes result rows by declared column kinds
            const decoded = yield* Db.actions.raw('SELECT * FROM "users"', [], { table: 'users' })
            const row = decoded.rows[0] as AnyType
            expect(row.active).toBe(false)
            expect(row.meta).toEqual({ tags: ['x'] })
            expect(row.joined).toEqual(joined)

            const badTable = yield* attempt(Db.actions.raw('SELECT 1', [], { table: 'ghosts' }))
            expect((badTable as AnyType).error).toBe(DbErrors.Validation)
          }),
        ),
      )
    })

    it.skipIf(target.live)('touch wakes query/doc watchers and bumps the version', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const created = yield* db.insert('users', { name: 'ada' })
            const id = String(created._id)

            const feed = yield* db.changes('users')
            const snaps = yield* db.query('users').watch()
            yield* snaps.next()
            const docFeed = yield* db.watch('users', id)
            yield* docFeed.next()

            yield* Db.actions.touch('users')
            // the feed subscribed after the insert, so its first event is the touch itself
            const touchEvent = yield* feed.next()
            expect(touchEvent.value).toMatchObject({ op: 'touch', id: '', doc: null, version: 2 })
            expect(db.version('users')).toBe(2)
            const snap = yield* snaps.next()
            expect((snap.value as AnyType).version).toBe(2)

            // doc-level touch re-fetches the current document for its watchers
            yield* Db.actions.touch('users', id)
            const refreshed = yield* docFeed.next()
            expect((refreshed.value as AnyType).name).toBe('ada')

            const unknown = yield* attempt(Db.actions.touch('ghosts'))
            expect((unknown as AnyType).error).toBe(DbErrors.Validation)
          }),
        ),
      )
    })

    it.skipIf(!target.live)('touch is inert when a native live feed owns the stream', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const feed = yield* db.changes('users')
            yield* db.insert('users', { name: 'ada' })
            const insertEvent = yield* feed.next()
            expect((insertEvent.value as AnyType).source).toBe('live')
            const before = db.version('users')

            yield* Db.actions.touch('users')
            expect(db.version('users')).toBe(before)

            const unknown = yield* attempt(Db.actions.touch('ghosts'))
            expect((unknown as AnyType).error).toBe(DbErrors.Validation)
          }),
        ),
      )
    })

    it.skipIf(!target.live)(
      'external writes reach watchers WITHOUT touch (native feed)',
      async () => {
        unwrap(
          await run(() =>
            scoped(function* () {
              const db = yield* bootstrap()
              yield* db.insert('users', { name: 'ada', age: 1 })
              const snaps = yield* db.query('users').watch()
              yield* snaps.next()

              // an out-of-band write: no hub publish, no touch — only the backend's own feed reports it
              yield* Db.actions.raw('UPDATE "users" SET "age" = 77')
              const snap = yield* snaps.next()
              expect((snap.value as AnyType).rows[0].age).toBe(77)
            }),
          ),
        )
      },
    )

    it.skipIf(!target.raw)('raw write + touch closes the reactivity gap', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            yield* db.insert('users', { name: 'ada', age: 1 })
            const snaps = yield* db.query('users').watch()
            yield* snaps.next()

            // out-of-band write: invisible to watchers until touched
            yield* Db.actions.raw('UPDATE "users" SET "age" = 99')
            yield* Db.actions.touch('users')
            const snap = yield* snaps.next()
            expect((snap.value as AnyType).rows[0].age).toBe(99)
          }),
        ),
      )
    })

    it('optimistic concurrency: ifVersion applies or fails db.conflict', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const created = yield* db.insert('users', { name: 'ada', age: 1 })
            const id = String(created._id)

            const patched = yield* db.patch('users', id, { age: 2 }, { ifVersion: 1 })
            expect(patched?._version).toBe(2)

            const stale = yield* attempt(db.patch('users', id, { age: 3 }, { ifVersion: 1 }))
            expect((stale as AnyType).error).toBe(DbErrors.Conflict)

            const missing = yield* db.patch('users', 'no-such-id', { age: 3 }, { ifVersion: 1 })
            expect(missing).toBeNull()

            const staleDelete = yield* attempt(db.delete('users', id, { ifVersion: 1 }))
            expect((staleDelete as AnyType).error).toBe(DbErrors.Conflict)
            expect(yield* db.delete('users', id, { ifVersion: 2 })).toBe(true)
          }),
        ),
      )
    })

    it('insertMany validates and stores a batch in one round trip', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            const feed = yield* db.changes('users')
            const docs = yield* db.insertMany('users', [
              { name: 'ada' },
              { name: 'grace' },
              { name: 'linus' },
            ])
            expect(docs).toHaveLength(3)
            expect(new Set(docs.map((doc: AnyType) => doc._id)).size).toBe(3)
            expect(yield* db.query('users').count()).toBe(3)
            for (const expected of ['ada', 'grace', 'linus']) {
              const step = yield* feed.next()
              expect((step.value as AnyType).op).toBe('insert')
              void expected
            }
            expect(yield* db.insertMany('users', [])).toEqual([])

            const invalid = yield* attempt(db.insertMany('users', [{ name: 'ok' }, { age: 1 }]))
            expect((invalid as AnyType).error).toBe(DbErrors.Validation)
            expect(yield* db.query('users').count()).toBe(3)
          }),
        ),
      )
    })

    it('watch: delta mode, coalescing, query-aware skip and since resume', async () => {
      unwrap(
        await run(() =>
          scoped(function* () {
            const db = yield* bootstrap()
            yield* db.insert('users', { name: 'ada', role: 'admin' })

            const deltas = yield* db
              .query('users')
              .where({ role: 'admin' })
              .watch({ mode: 'delta' })
            const initial = yield* deltas.next()
            expect((initial.value as AnyType).added.map((row: AnyType) => row.name)).toEqual([
              'ada',
            ])

            // one transaction, two inserts — coalesces into a single delta emission
            yield* db.transaction(function* (tx: AnyType) {
              yield* tx.insert('users', { name: 'grace', role: 'admin' })
              yield* tx.insert('users', { name: 'hopper', role: 'admin' })
            })
            const batch = yield* deltas.next()
            expect(
              (batch.value as AnyType).added.map((row: AnyType) => row.name).toSorted(),
            ).toEqual(['grace', 'hopper'])

            // a non-matching insert is skipped without waking the watcher; the matching patch lands
            yield* db.insert('users', { name: 'linus', role: 'member' })
            const admin = yield* db.query('users').where({ name: 'ada' }).unique()
            yield* db.patch('users', String((admin as AnyType)._id), { age: 40 })
            const changed = yield* deltas.next()
            expect((changed.value as AnyType).changed.map((row: AnyType) => row.name)).toEqual([
              'ada',
            ])
            expect((changed.value as AnyType).added).toEqual([])

            // since-resume: a consumer already at the current version skips the initial emission
            const current = db.version('users')
            const resumed = yield* db.query('users').order('name').watch({ since: current })
            yield* db.insert('users', { name: 'zuse' })
            const first = yield* resumed.next()
            expect((first.value as AnyType).rows.map((row: AnyType) => row.name)).toContain('zuse')
            expect((first.value as AnyType).version).toBeGreaterThan(current)
          }),
        ),
      )
    })

    it('scope teardown resolves promptly with active watchers parked', async () => {
      const task = run(function* () {
        const db = yield* bootstrap()
        // park subscriptions without draining them, then let the scope close over them
        yield* db.changes('users')
        const snaps = yield* db.query('users').watch()
        yield* snaps.next()
        yield* db.insert('users', { name: 'ada' })
        return 'closed'
      })
      const winner = await Promise.race([
        task.then(() => 'completed'),
        new Promise(resolve => {
          setTimeout(() => resolve('timeout'), 3000)
        }),
      ])
      expect(winner).toBe('completed')
    })
  })
}
