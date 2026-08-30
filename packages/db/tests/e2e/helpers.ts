import { column, Db, DbAdapter, DbClient, DbErrors, table, where } from 'db:core'
import { isDestructive } from 'db:internal'
import type { Operation } from 'std:effect'
import { attempt, race, run, scoped, sleep, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'

import { posts, users } from '../helpers'

const TOKEN = /^[0-9A-HJKMNP-TV-Z]{22}$/u

/** One database+driver binding under end-to-end test. */
export interface AdapterTarget {
  /** Must equal the adapter's `info.adapter` name. */
  readonly label: string
  /** false → the whole suite is skipped (e.g. no live server configured). */
  readonly enabled: boolean
  /** Whether the adapter declares the `raw` capability. */
  readonly raw: boolean
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
    yield* install(BunIO)
    const db = yield* install(DbClient, { tables: [users, posts], migrations: 'manual' })
    yield* Db.actions.dropTable('posts')
    yield* Db.actions.dropTable('users')
    yield* Db.actions.migrate()
    return db
  }

  describe.skipIf(!target.enabled)(`e2e — ${target.label}`, () => {
    it('reports adapter info and capabilities', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const info = yield* useContext(DbAdapter)
          expect(info.adapter).toBe(target.label)
          expect(info.capabilities.transactions).toBe(true)
          expect(info.capabilities.raw).toBe(target.raw)
        }),
      )
    })

    it('insert stamps system fields, applies defaults, strips unknown keys', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const doc = yield* db.insert('users', { name: 'ada', age: 36, junk: 'nope' })
          expect(typeof doc._id).toBe('string')
          expect(typeof doc._created_at).toBe('number')
          expect(doc._version).toMatch(TOKEN)
          expect(doc._updated_at).toBe(doc._created_at)
          expect(doc.role).toBe('member')
          expect(doc.active).toBe(true)
          expect(doc.meta).toBeNull()
          expect('junk' in doc).toBe(false)
        }),
      )
    })

    it('rejects invalid writes with db.validation', async () => {
      unwrap(
        await run(function* () {
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
      )
    })

    it('get / patch / replace / delete lifecycle with version bumps', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const created = yield* db.insert('users', { name: 'ada', age: 36 })
          const id = String(created._id)

          const loaded = yield* db.get('users', id)
          expect(loaded?.name).toBe('ada')

          yield* sleep(2)
          const patched = yield* db.patch('users', id, { age: 37 })
          expect(patched?.age).toBe(37)
          expect(patched?._version).toMatch(TOKEN)
          expect(String(patched?._version) > String(created._version)).toBe(true)
          expect(Number(patched?._updated_at)).toBeGreaterThan(Number(created._created_at))

          const replaced = yield* db.replace('users', id, { name: 'lovelace' })
          expect(replaced?.name).toBe('lovelace')
          expect(replaced?.age).toBeNull()
          expect(String(replaced?._version) > String(patched?._version)).toBe(true)

          expect(yield* db.delete('users', id)).toBe(true)
          expect(yield* db.get('users', id)).toBeNull()
          expect(yield* db.delete('users', id)).toBe(false)
          expect(yield* db.patch('users', id, { age: 1 })).toBeNull()
        }),
      )
    })

    it('round-trips boolean, json, timestamp, enum and reference values', async () => {
      unwrap(
        await run(function* () {
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
      )
    })

    it('query surface: filters, order, take, first, unique, count, exists', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          yield* db.insert('users', { name: 'ada', age: 36, role: 'admin' })
          yield* db.insert('users', { name: 'grace', age: 45, role: 'admin' })
          yield* db.insert('users', { name: 'linus', age: 25 })
          yield* db.insert('users', { name: 'margaret' })

          const admins = yield* db.query('users').where({ role: 'admin' }).order('name').collect()
          expect(admins.map((row: AnyType) => row.name)).toEqual(['ada', 'grace'])

          const seniors = yield* db
            .query('users')
            .filter(where.gt('age', 30))
            .order('age', 'desc')
            .collect()
          expect(seniors.map((row: AnyType) => row.name)).toEqual(['grace', 'ada'])

          const g = yield* db.query('users').filter(where.like('name', 'g%')).collect()
          expect(g.map((row: AnyType) => row.name)).toEqual(['grace'])

          const caseless = yield* db.query('users').filter(where.ilike('name', 'ADA')).collect()
          expect(caseless.map((row: AnyType) => row.name)).toEqual(['ada'])

          const pair = yield* db
            .query('users')
            .filter(where.oneOf('name', ['ada', 'linus']))
            .order('name')
            .collect()
          expect(pair.map((row: AnyType) => row.name)).toEqual(['ada', 'linus'])

          const mixed = yield* db
            .query('users')
            .filter(where.or(where.like('name', 'mar%'), where.gt('age', 40)))
            .order('name')
            .collect()
          expect(mixed.map((row: AnyType) => row.name)).toEqual(['grace', 'margaret'])

          expect(yield* db.query('users').filter(where.notNull('age')).count()).toBe(3)
          // the rest of the algebra: ne / gte / lte / notOneOf / isNull / not / and
          expect(yield* db.query('users').filter(where.ne('name', 'ada')).count()).toBe(3)
          expect(yield* db.query('users').filter(where.gte('age', 36)).count()).toBe(2)
          expect(yield* db.query('users').filter(where.lte('age', 36)).count()).toBe(2)
          expect(
            (yield* db
              .query('users')
              .filter(where.notOneOf('name', ['ada', 'linus']))
              .collect()).map((row: AnyType) => row.name),
          ).toEqual(['grace', 'margaret'])
          expect(yield* db.query('users').filter(where.isNull('age')).count()).toBe(1)
          expect(
            yield* db
              .query('users')
              .filter(where.not(where.like('name', 'g%')))
              .count(),
          ).toBe(3)
          expect(
            yield* db
              .query('users')
              .filter(where.and(where.gt('age', 30), where.not(where.eq('name', 'grace'))))
              .count(),
          ).toBe(1)
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
      )
    })

    it('multi-key order: sort keys stack, and pagination walks all of them', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()

          // two roles x three ages, deliberately inserted out of order
          for (const [name, role, age] of [
            ['e', 'member', 1],
            ['c', 'admin', 3],
            ['a', 'admin', 1],
            ['d', 'member', 2],
            ['b', 'admin', 2],
            ['f', 'member', 3],
          ] as const) {
            yield* db.insert('users', { name, role, age })
          }

          const sorted = yield* db.query('users').order('role').order('age', 'desc').collect()

          expect(sorted.map((row: AnyType) => row.name)).toEqual(['c', 'b', 'a', 'f', 'd', 'e'])

          // the same order, paginated: the cursor must carry BOTH keys or the window drifts
          const query = () => db.query('users').order('role').order('age', 'desc')
          const one = yield* query().paginate({ limit: 2 })
          expect(one.data.map((row: AnyType) => row.name)).toEqual(['c', 'b'])

          const two = yield* query().paginate({ limit: 2, cursor: one.pageInfo.nextCursor })
          expect(two.data.map((row: AnyType) => row.name)).toEqual(['a', 'f'])

          const three = yield* query().paginate({ limit: 2, cursor: two.pageInfo.nextCursor })
          expect(three.data.map((row: AnyType) => row.name)).toEqual(['d', 'e'])
          expect(three.pageInfo.hasNext).toBe(false)

          // and back again
          const back = yield* query().paginate({
            limit: 2,
            cursor: three.pageInfo.prevCursor,
            direction: 'backward',
          })
          expect(back.data.map((row: AnyType) => row.name)).toEqual(['a', 'f'])
        }),
      )
    })

    it('select projects columns; the system fields ride along', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          yield* db.insert('users', { name: 'ada', age: 36, role: 'admin' })

          const rows = yield* db.query('users').select('name', 'age').collect()
          const row = rows[0] as AnyType

          expect(row.name).toBe('ada')
          expect(row.age).toBe(36)
          expect('role' in row).toBe(false)

          // pagination and versioning still work on a projected query
          expect(typeof row._id).toBe('string')
          expect(row._version).toMatch(TOKEN)

          const page = yield* db.query('users').select('name').order('name').paginate({ limit: 1 })
          expect((page.data[0] as AnyType).name).toBe('ada')
          expect('age' in (page.data[0] as AnyType)).toBe(false)
        }),
      )
    })

    it('aggregates: sum/avg/min/max in the backend, and grouped answers', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          yield* db.insert('users', { name: 'ada', age: 36, role: 'admin' })
          yield* db.insert('users', { name: 'grace', age: 44, role: 'admin' })
          yield* db.insert('users', { name: 'linus', age: 25, role: 'member' })
          yield* db.insert('users', { name: 'nobody', role: 'member' })

          const all = db.query('users')
          expect(yield* all.sum('age')).toBe(105)
          expect(yield* all.min('age')).toBe(25)
          expect(yield* all.max('age')).toBe(44)
          expect(yield* all.avg('age')).toBe(35)

          // the filter applies to the aggregate too
          expect(yield* db.query('users').where({ role: 'admin' }).sum('age')).toBe(80)

          // nothing matched: sum is 0, the rest are null
          const none = db.query('users').filter(where.gt('age', 1000))
          expect(yield* none.sum('age')).toBe(0)
          expect(yield* none.avg('age')).toBe(null)
          expect(yield* none.max('age')).toBe(null)

          const byRole = yield* db.query('users').groupBy('role').count()
          const counts = Object.fromEntries(
            byRole.map((row: AnyType) => [row.role, Number(row.count)]),
          )
          expect(counts).toEqual({ admin: 2, member: 2 })

          const sums = yield* db.query('users').groupBy('role').sum('age')
          expect(
            Object.fromEntries(sums.map((row: AnyType) => [row.role, Number(row.sum)])),
          ).toEqual({ admin: 80, member: 25 })

          // an unknown column is a validation failure, not a silent empty answer
          const bad = yield* attempt(() => db.query('users').sum('nope' as AnyType))
          expect(isFailure(bad) && bad.error).toBe(DbErrors.Validation)
        }),
      )
    })

    it('upsert inserts once, then patches the same row', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()

          const created = yield* db.upsert('users', { name: 'ada' }, { name: 'ada', age: 36 })
          expect(created.age).toBe(36)

          const updated = yield* db.upsert('users', { name: 'ada' }, { name: 'ada', age: 37 })
          expect(updated._id).toBe(created._id)
          expect(updated.age).toBe(37)
          expect(yield* db.query('users').count()).toBe(1)
        }),
      )
    })

    it('keyset pagination forward and backward', async () => {
      unwrap(
        await run(function* () {
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

          // a bare row id is an INCLUSIVE boundary: the page STARTS at that row — here on a
          // non-id order column (the boundary row is looked up for its order value)
          const cId = String(pageTwo.data[0]!._id)
          const fromRow = yield* query().paginate({ limit: 2, cursor: cId })
          expect(fromRow.data.map((row: AnyType) => row.name)).toEqual(['c', 'd'])

          // and on the default `_id` order — no lookup, a vanished row degrades gracefully
          const fromId = yield* db.query('users').paginate({ limit: 3, cursor: cId })
          expect(fromId.data[0]!.name).toBe('c')

          // a bare id naming no row on a value-ordered paginate is a clear failure
          const missing = yield* attempt(
            query().paginate({ limit: 2, cursor: '00000000000000000000000000000000' }),
          )
          expect((missing as AnyType).error).toBe(DbErrors.Cursor)

          // the boundary lookup carries the query's own filter: a bare id OUTSIDE the query's
          // set (here: another role) answers EXACTLY like a missing one — no cross-scope
          // existence oracle — while an in-scope bare id still positions the window
          yield* db.insert('users', { name: 'zed', age: 6, role: 'admin' })
          const members = () => db.query('users').where({ role: 'member' }).order('age')

          const inScope = yield* members().paginate({ limit: 2, cursor: cId })
          expect(inScope.data.map((row: AnyType) => row.name)).toEqual(['c', 'd'])

          const admin = yield* db.query('users').where({ role: 'admin' }).first()
          const foreignId = String((admin as AnyType)._id)
          const foreign = yield* attempt(members().paginate({ limit: 2, cursor: foreignId }))
          const absent = yield* attempt(
            members().paginate({ limit: 2, cursor: '00000000000000000000000000000000' }),
          )
          expect((foreign as AnyType).error).toBe(DbErrors.Cursor)
          expect((absent as AnyType).error).toBe(DbErrors.Cursor)
          expect(String((foreign as AnyType).message).replace(foreignId, 'ID')).toBe(
            String((absent as AnyType).message).replace('00000000000000000000000000000000', 'ID'),
          )
        }),
      )
    })

    it('maps unique-index violations to db.unique', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          yield* db.insert('users', { name: 'dup' })
          const outcome = yield* attempt(db.insert('users', { name: 'dup' }))
          expect(isFailure(outcome)).toBe(true)
          expect((outcome as AnyType).error).toBe(DbErrors.Unique)
        }),
      )
    })

    it('reactive: changes feed carries op/doc/version and filters by table', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const usersFeed = yield* db.changes('users')
          const postsFeed = yield* db.changes('posts')

          const created = yield* db.insert('users', { name: 'ada' })
          yield* db.insert('posts', { title: 'notes', author: created._id })
          yield* db.patch('users', String(created._id), { age: 36 })
          yield* db.delete('users', String(created._id))

          // events carry identity + op (+ changed field names) and a token — never documents
          const first = yield* usersFeed.next()
          expect(first.value).toMatchObject({
            table: 'users',
            id: created._id,
            op: 'insert',
            source: 'local',
          })
          expect((first.value as AnyType).token).toMatch(TOKEN)
          expect('new' in (first.value as AnyType)).toBe(false)

          const second = yield* usersFeed.next()
          expect(second.value).toMatchObject({ op: 'update', fields: ['age'] })
          expect((second.value as AnyType).token > (first.value as AnyType).token).toBe(true)

          const third = yield* usersFeed.next()
          expect(third.value).toMatchObject({ op: 'delete' })
          expect('fields' in (third.value as AnyType)).toBe(false)

          const postEvent = yield* postsFeed.next()
          expect(postEvent.value).toMatchObject({ table: 'posts', op: 'insert' })
          // the table version is the token of the last applied change
          expect(db.version('users')).toBe((third.value as AnyType).token)
          expect(db.version('posts')).toBe((postEvent.value as AnyType).token)
        }),
      )
    })

    it('reactive: query watch and doc watch re-emit on relevant changes', async () => {
      unwrap(
        await run(function* () {
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
          // the emitted token is what the snapshot REFLECTS (usable as `since`)
          expect((updated.value as AnyType).token > (initial.value as AnyType).token).toBe(true)
          expect((updated.value as AnyType).token).toBe(db.version('users'))

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
      )
    })

    it('transactions: commit flushes buffered events, rollback emits nothing, savepoints nest', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const feed = yield* db.changes('users')

          const committed = yield* db.transaction(function* (tx: AnyType) {
            const ada = yield* tx.insert('users', { name: 'ada' })
            const grace = yield* tx.insert('users', { name: 'grace' })
            return [ada._id, grace._id]
          })
          expect(yield* db.query('users').count()).toBe(2)
          expect(((yield* feed.next()).value as AnyType).id).toBe(committed[0])
          expect(((yield* feed.next()).value as AnyType).id).toBe(committed[1])

          const outcome = yield* attempt(
            db.transaction(function* (tx: AnyType) {
              yield* tx.insert('users', { name: 'doomed' })
              return yield* fail(DbErrors.Query, 'boom')
            }),
          )
          expect(isFailure(outcome)).toBe(true)
          expect(yield* db.query('users').count()).toBe(2)

          const outerId = yield* db.transaction(function* (tx: AnyType) {
            const outer = yield* tx.insert('users', { name: 'outer' })
            const inner = yield* attempt(
              tx.transaction(function* (nested: AnyType) {
                yield* nested.insert('users', { name: 'inner' })
                return yield* fail(DbErrors.Query, 'inner boom')
              }),
            )
            expect(isFailure(inner)).toBe(true)
            return outer._id
          })
          const names = yield* db.query('users').order('name').collect()
          expect(names.map((row: AnyType) => row.name)).toEqual(['ada', 'grace', 'outer'])

          // rolled-back writes never reached the feed: the next event is the outer insert
          expect(((yield* feed.next()).value as AnyType).id).toBe(outerId)

          // a nested transaction that COMMITS: the OUTER one owns the single change-log write
          // (logging its own buffer too would insert the same tokens twice → db.unique)
          const joined = yield* db.transaction(function* (tx: AnyType) {
            const outer = yield* tx.insert('users', { name: 'joined-outer' })
            const inner = yield* tx.transaction(function* (nested: AnyType) {
              return yield* nested.insert('users', { name: 'joined-inner' })
            })
            return [outer._id, inner._id]
          })
          expect(((yield* feed.next()).value as AnyType).id).toBe(joined[0])
          expect(((yield* feed.next()).value as AnyType).id).toBe(joined[1])

          // `upsert` IS a transaction — nested inside one it must still commit
          const upserted = yield* db.transaction(function* (tx: AnyType) {
            yield* tx.upsert('users', { name: 'ada' }, { age: 30 })
            return yield* tx.upsert('users', { name: 'ada' }, { age: 31 })
          })
          expect(upserted.age).toBe(31)
        }),
      )
    })

    it('scoped handle: narrowed reads, guarded writes, stamped inserts, retracted misses', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const a = (db as AnyType).scoped(where.eq('role', 'member'))

          // stamp: the scope pins `role` onto the insert, overriding the value
          const member = yield* a.insert('users', { name: 'scoped-member', role: 'admin' })
          expect(member.role).toBe('member')
          const admin = yield* db.insert('users', { name: 'scoped-admin', role: 'admin' })

          // reads narrowed; foreign row absent
          expect(yield* a.get('users', admin._id)).toBeNull()
          expect((yield* a.query('users').collect()).map((row: AnyType) => row.name)).toEqual([
            'scoped-member',
          ])

          // guarded writes: miss (not conflict) outside the scope, even with a stale version
          const before = yield* Db.actions.logStats('users')
          expect(yield* a.patch('users', admin._id, { age: 9 })).toBeNull()
          const hidden = yield* attempt(
            a.patch('users', admin._id, { age: 9 }, { ifVersion: 'v:stale' }),
          )
          expect(isFailure(hidden)).toBe(false)
          expect(yield* a.delete('users', admin._id)).toBe(false)

          // ...and none of those misses left a phantom change-log row
          const after = yield* Db.actions.logStats('users')
          expect(after.rows).toBe(before.rows)

          // upsert under a per-call scope: both branches
          const up = yield* db.upsert(
            'users',
            { name: 'scoped-up' },
            { role: 'member' },
            { scope: where.eq('role', 'member') },
          )
          expect(up.role).toBe('member')
          const again = yield* db.upsert(
            'users',
            { name: 'scoped-up' },
            { age: 7 },
            { scope: where.eq('role', 'member') },
          )
          expect(again._id).toBe(up._id)
          expect(again.age).toBe(7)

          // an insert under a scope that pins nothing exact refuses
          const denied = yield* attempt(
            (db as AnyType).scoped(where.gt('age', 3)).insert('users', { name: 'scoped-denied' }),
          )
          expect(isFailure(denied)).toBe(true)
          expect((denied as AnyType).error).toBe(DbErrors.Validation)
        }),
      )
    })

    it('management plane: plan, reindex, dropIndex, dropTable', async () => {
      unwrap(
        await run(function* () {
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
      )
    })

    it(`raw escape hatch is ${target.raw ? 'available' : 'cleanly unsupported'}`, async () => {
      unwrap(
        await run(function* () {
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

          // backend constraint errors keep their taxonomy through raw as well
          const pair = target.label === 'sqlite' ? '?, ?' : '$1, $2'
          const nullName = yield* attempt(
            Db.actions.raw(`INSERT INTO "users" ("_id", "_version") VALUES (${pair})`, [
              'raw-1',
              '0',
            ]),
          )
          expect((nullName as AnyType).error).toBe(DbErrors.NotNull)
          const badTable = yield* attempt(Db.actions.raw('SELECT 1', [], { table: 'ghosts' }))
          expect((badTable as AnyType).error).toBe(DbErrors.Validation)
        }),
      )
    })

    it('touch wakes query/doc watchers and bumps the version', async () => {
      unwrap(
        await run(function* () {
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
          expect(touchEvent.value).toMatchObject({ op: 'touch', id: '', source: 'local' })
          const touchToken = (touchEvent.value as AnyType).token
          expect(touchToken > String(created._version)).toBe(true)
          expect(db.version('users')).toBe(touchToken)
          const snap = yield* snaps.next()
          expect((snap.value as AnyType).token).toBe(touchToken)

          // doc-level touch re-fetches the current document for its watchers
          yield* Db.actions.touch('users', id)
          const refreshed = yield* docFeed.next()
          expect((refreshed.value as AnyType).name).toBe('ada')

          const unknown = yield* attempt(Db.actions.touch('ghosts'))
          expect((unknown as AnyType).error).toBe(DbErrors.Validation)
        }),
      )
    })

    it('touchBatch emits one touch per id in a single flush', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const a = yield* db.insert('users', { name: 'a' })
          const b = yield* db.insert('users', { name: 'b' })
          const feed = yield* db.changes('users')
          const before = db.version('users')

          yield* Db.actions.touchBatch('users', [String(a._id), String(b._id)])
          const first = yield* feed.next()
          const second = yield* feed.next()
          expect(first.value).toMatchObject({ op: 'touch', id: String(a._id), source: 'local' })
          expect(second.value).toMatchObject({ op: 'touch', id: String(b._id), source: 'local' })
          expect((second.value as AnyType).token > (first.value as AnyType).token).toBe(true)
          expect(db.version('users')).toBe((second.value as AnyType).token)

          // buffered inside a transaction like any write — nothing leaks before commit
          const inside = db.version('users')
          yield* db.transaction(function* () {
            yield* Db.actions.touchBatch('users', [String(a._id)])
            expect(db.version('users')).toBe(inside)
          })
          expect(db.version('users') > inside).toBe(true)
          expect(db.version('users') > before).toBe(true)
          expect((yield* feed.next()).value).toMatchObject({ op: 'touch', id: String(a._id) })
        }),
      )
    })

    it.skipIf(!target.raw)('raw write + touch closes the reactivity gap', async () => {
      unwrap(
        await run(function* () {
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
      )
    })

    it.skipIf(!target.raw)(
      'raw emit: RETURNING rows become changes, rows are re-versioned',
      async () => {
        unwrap(
          await run(function* () {
            const db = yield* bootstrap()
            const ada = yield* db.insert('users', { name: 'ada', age: 1 })
            const bob = yield* db.insert('users', { name: 'bob', age: 70 })
            const deltas = yield* db.query('users').watch({ mode: 'delta' })
            yield* deltas.next()
            const feed = yield* db.changes('users')

            yield* Db.actions.raw(
              'UPDATE "users" SET "age" = $1 WHERE "age" > $2 RETURNING "_id"',
              [99, 50],
              { table: 'users', emit: { op: 'update', fields: ['age'] } },
            )
            // the event names the row, the op and the changed columns; the row carries a NEW token
            const event = yield* feed.next()
            expect(event.value).toMatchObject({ id: bob._id, op: 'update', fields: ['age'] })
            const stamped = yield* db.get('users', String(bob._id))
            expect(stamped?._version).toBe((event.value as AnyType).token)
            expect(stamped?.age).toBe(99)
            expect(String(stamped?._version) > String(bob._version)).toBe(true)
            // …so a delta watcher sees it as changed, and the log has it
            const delta = yield* deltas.next()
            expect((delta.value as AnyType).changed.map((row: AnyType) => row.name)).toEqual([
              'bob',
            ])
            const entries = yield* Db.actions.log('users', { since: String(bob._version) })
            expect(entries.at(-1)).toMatchObject({ id: bob._id, op: 'update', fields: ['age'] })

            // ada was untouched by the statement: same version, no event
            expect((yield* db.get('users', String(ada._id)))?._version).toBe(ada._version)

            // a statement returning nothing cannot be announced: loud failure, not silent staleness
            const silent = yield* attempt(
              Db.actions.raw('UPDATE "users" SET "age" = 1', [], {
                table: 'users',
                emit: { op: 'update' },
              }),
            )
            expect((silent as AnyType).error).toBe(DbErrors.Validation)
            const noTable = yield* attempt(
              Db.actions.raw('SELECT 1', [], { emit: { op: 'update' } }),
            )
            expect((noTable as AnyType).error).toBe(DbErrors.Validation)

            // manual versioning with `version()` + stamp: false
            const token = yield* Db.actions.version()
            yield* Db.actions.raw(
              'UPDATE "users" SET "_version" = $1 WHERE "_id" = $2 RETURNING "_id"',
              [token, String(ada._id)],
              { table: 'users', emit: { op: 'update', fields: ['age'], stamp: false } },
            )
            expect((yield* db.get('users', String(ada._id)))?._version).toBe(token)
          }),
        )
      },
    )

    it('publish: announced writes become events and log rows; malformed ones fail db.validation', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const ada = yield* db.insert('users', { name: 'ada' })
          const feed = yield* db.changes('users')
          yield* Db.actions.publish([
            { table: 'users', id: String(ada._id), op: 'update', fields: ['age'] },
            { table: 'users', id: 'gone', op: 'delete' },
          ])
          const first = yield* feed.next()
          const second = yield* feed.next()
          expect(first.value).toMatchObject({
            id: ada._id,
            op: 'update',
            fields: ['age'],
            source: 'local',
          })
          expect(second.value).toMatchObject({ id: 'gone', op: 'delete' })
          const entries = yield* Db.actions.log('users', { since: String(ada._version) })
          expect(entries.map(entry => entry.op)).toEqual(['update', 'delete'])

          const bad = [
            [{ table: 'ghosts', id: '1', op: 'insert' }],
            [{ table: 'users', id: '1', op: 'insert', fields: ['name'] }],
            [{ table: 'users', id: '1', op: 'update', fields: ['nope'] }],
          ] as const
          for (const writes of bad) {
            const outcome = yield* attempt(Db.actions.publish(writes as AnyType))
            expect((outcome as AnyType).error).toBe(DbErrors.Validation)
          }
        }),
      )
    })

    it('optimistic concurrency: ifVersion applies or fails db.conflict', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          const created = yield* db.insert('users', { name: 'ada', age: 1 })
          const id = String(created._id)

          const v1 = String(created._version)
          const patched = yield* db.patch('users', id, { age: 2 }, { ifVersion: v1 })
          const v2 = String(patched?._version)
          expect(v2 > v1).toBe(true)

          const stale = yield* attempt(db.patch('users', id, { age: 3 }, { ifVersion: v1 }))
          expect((stale as AnyType).error).toBe(DbErrors.Conflict)

          const missing = yield* db.patch('users', 'no-such-id', { age: 3 }, { ifVersion: v1 })
          expect(missing).toBeNull()

          const staleDelete = yield* attempt(db.delete('users', id, { ifVersion: v1 }))
          expect((staleDelete as AnyType).error).toBe(DbErrors.Conflict)
          expect(yield* db.delete('users', id, { ifVersion: v2 })).toBe(true)
        }),
      )
    })

    it('insertMany validates and stores a batch in one round trip', async () => {
      unwrap(
        await run(function* () {
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
      )
    })

    it('watch: delta mode, coalescing, query-aware skip and since resume', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          yield* db.insert('users', { name: 'ada', role: 'admin' })

          const deltas = yield* db.query('users').where({ role: 'admin' }).watch({ mode: 'delta' })
          const initial = yield* deltas.next()
          expect((initial.value as AnyType).added.map((row: AnyType) => row.name)).toEqual(['ada'])

          // one transaction, two inserts — coalesces into a single delta emission
          yield* db.transaction(function* (tx: AnyType) {
            yield* tx.insert('users', { name: 'grace', role: 'admin' })
            yield* tx.insert('users', { name: 'hopper', role: 'admin' })
          })
          const batch = yield* deltas.next()
          expect((batch.value as AnyType).added.map((row: AnyType) => row.name).toSorted()).toEqual(
            ['grace', 'hopper'],
          )

          // a non-matching insert recomputes to an empty delta (suppressed); the matching patch lands
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
          expect((first.value as AnyType).token > current).toBe(true)
        }),
      )
    })

    it('change log: every write leaves a row; log/logStats/compact manage it', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          expect(yield* Db.actions.logStats('users')).toEqual({
            rows: 0,
            oldest: null,
            newest: null,
          })

          const ada = yield* db.insert('users', { name: 'ada' })
          yield* db.patch('users', String(ada._id), { age: 1 })
          yield* db.delete('users', String(ada._id))
          yield* Db.actions.touch('users')

          const entries = yield* Db.actions.log('users')
          expect(entries.map(entry => entry.op)).toEqual(['insert', 'update', 'delete', 'touch'])
          expect(entries[0]!.token).toBe(ada._version)
          expect(entries[1]!.fields).toEqual(['age'])
          expect(entries[3]!.id).toBe('')
          // outside a transaction every change is its own group
          expect(entries.every(entry => entry.tx === entry.token)).toBe(true)
          expect(entries.every(entry => typeof entry.ts === 'number')).toBe(true)

          const after = yield* Db.actions.log('users', { since: entries[1]!.token })
          expect(after.map(entry => entry.op)).toEqual(['delete', 'touch'])

          const stats = yield* Db.actions.logStats('users')
          expect(stats).toEqual({ rows: 4, oldest: entries[0]!.token, newest: entries[3]!.token })
          expect(db.version('users')).toBe(stats.newest)

          // keep the newest 2; the newest row always survives even an unbounded compact
          expect(yield* Db.actions.compact('users', { keep: 2 })).toBe(2)
          expect((yield* Db.actions.logStats('users')).rows).toBe(2)
          expect(yield* Db.actions.compact()).toBe(1)
          expect(yield* Db.actions.logStats('users')).toMatchObject({
            rows: 1,
            newest: stats.newest,
          })
        }),
      )
    })

    it('change log: a transaction writes one group right before commit, nothing on rollback', async () => {
      unwrap(
        await run(function* () {
          const db = yield* bootstrap()
          yield* db.transaction(function* (tx: AnyType) {
            yield* tx.insert('users', { name: 'a' })
            yield* tx.insert('users', { name: 'b' })
            // not visible yet: the log rows land as the transaction's last step
            expect((yield* Db.actions.logStats('users')).rows).toBe(0)
          })
          const entries = yield* Db.actions.log('users')
          expect(entries).toHaveLength(2)
          expect(entries[0]!.tx).toBe(entries[1]!.tx)
          expect(entries[0]!.tx).not.toBe(entries[0]!.token)

          yield* attempt(
            db.transaction(function* (tx: AnyType) {
              yield* tx.insert('users', { name: 'doomed' })
              return yield* fail(DbErrors.Query, 'boom')
            }),
          )
          expect((yield* Db.actions.logStats('users')).rows).toBe(2)
        }),
      )
    })

    it('change log: hidden from the handle, reserved names rejected, dropped with its table', async () => {
      unwrap(
        await run(function* () {
          yield* bootstrap()
          const hidden = yield* attempt(Db.actions.touch('__changes_users'))
          expect((hidden as AnyType).error).toBe(DbErrors.Validation)
          const reserved = yield* attempt(
            install(DbClient, { tables: [table('__secret', { x: column.text() })] }),
          )
          expect((reserved as AnyType).error).toBe(DbErrors.Configuration)

          // the schema speaks snake_case: camelCase table and column names are refused
          const camelTable = yield* attempt(
            install(DbClient, { tables: [table('uploadChunks', { x: column.text() })] }),
          )
          expect((camelTable as AnyType).error).toBe(DbErrors.Configuration)
          const camelColumn = yield* attempt(
            install(DbClient, { tables: [table('chunks', { requestId: column.text() })] }),
          )
          expect((camelColumn as AnyType).error).toBe(DbErrors.Configuration)
          expect((camelColumn as AnyType).message).toContain('requestId')

          yield* Db.actions.dropTable('posts')
          const plan = yield* Db.actions.planMigration()
          const created = plan.steps
            .filter((step: AnyType) => step.kind === 'create-table')
            .map((step: AnyType) => step.table.name)
          expect(created).toEqual(['posts', '__changes_posts'])
        }),
      )
    })

    it('type drift: the plan reports alter-column; applied with a cast only where supported', async () => {
      const v1 = table('gauges', { value: column.text() })
      const v2 = table('gauges', { value: column.int() })
      unwrap(
        await run(function* () {
          yield* target.install()
          yield* install(BunIO)
          const before = yield* install(DbClient, { tables: [v1], migrations: 'manual' })
          yield* Db.actions.dropTable('gauges')
          yield* Db.actions.migrate()
          yield* before.insert('gauges', { value: '42' })
          // the same storage, re-declared: a child scope installs the new schema over it
          yield* scoped(function* () {
            const db = yield* install(DbClient, { tables: [v2], migrations: 'manual' })
            const { capabilities } = yield* useContext(DbAdapter)
            const drift = (yield* Db.actions.planMigration()).steps.find(
              (step: AnyType) => step.kind === 'alter-column',
            ) as AnyType
            expect(drift).toMatchObject({
              table: 'gauges',
              from: 'text',
              unsupported: !capabilities.alterColumn,
            })
            expect(drift.column.kind).toBe('int')
            expect(isDestructive(drift)).toBe(true)

            yield* Db.actions.migrate()
            const after = (yield* Db.actions.planMigration()).steps.filter(
              (step: AnyType) => step.kind === 'alter-column',
            )
            const row = (yield* db.query('gauges').first()) as AnyType
            if (capabilities.alterColumn) {
              // retyped in place, the data cast along
              expect(after).toHaveLength(0)
              expect(row.value).toBe(42)
            } else {
              // reported, never applied: the column (and its data) stay as they were
              expect(after).toHaveLength(1)
              expect(String(row.value)).toBe('42')
            }
          })
        }),
      )
    })

    it('leftovers: a table removed from the schema (and its log) is planned away; foreign tables stay', async () => {
      unwrap(
        await run(function* () {
          yield* target.install()
          yield* install(BunIO)
          const before = yield* install(DbClient, { tables: [users, posts], migrations: 'manual' })
          yield* Db.actions.dropTable('posts')
          yield* Db.actions.dropTable('users')
          yield* Db.actions.migrate()
          yield* before.insert('users', { name: 'ada' })
          if (target.raw) {
            yield* Db.actions.raw('DROP TABLE IF EXISTS "visitors"')
            yield* Db.actions.raw('CREATE TABLE "visitors" ("_id" TEXT PRIMARY KEY)')
          }

          // the same storage, `posts` no longer declared
          yield* scoped(function* () {
            yield* install(DbClient, { tables: [users], migrations: 'manual', safe: true })
            const plan = yield* Db.actions.planMigration()
            const dropped = plan.steps
              .filter((step: AnyType) => step.kind === 'drop-table')
              .map((step: AnyType) => step.table)
            // `posts` carried a change log, so it is ours: both go; `visitors` has none: it stays
            expect(dropped).toEqual(['posts', '__changes_posts'])
            expect(dropped).not.toContain('visitors')
            // safe mode only reports
            yield* Db.actions.migrate()
            const after = yield* Db.actions.planMigration()
            expect(after.steps.filter((step: AnyType) => step.kind === 'drop-table')).toHaveLength(
              2,
            )
          })
          yield* scoped(function* () {
            yield* install(DbClient, { tables: [users], migrations: 'manual' })
            yield* Db.actions.migrate()
            const tables = yield* DbAdapter.actions.tables()
            expect(tables).not.toContain('posts')
            expect(tables).not.toContain('__changes_posts')
            expect(tables).toContain('users')
            if (target.raw) {
              expect(tables).toContain('visitors')
              yield* Db.actions.raw('DROP TABLE "visitors"')
            }
            // a declared table dropped behind our back comes back with a FRESH log
            yield* DbAdapter.actions.migrate([{ kind: 'drop-table', table: 'users' }])
            const vanished = yield* Db.actions.planMigration()
            const kinds = vanished.steps.map(
              (step: AnyType) => `${step.kind}:${step.table.name ?? step.table}`,
            )
            expect(kinds.indexOf('drop-table:__changes_users')).toBeGreaterThanOrEqual(0)
            expect(kinds.indexOf('drop-table:__changes_users')).toBeLessThan(
              kinds.indexOf('create-table:__changes_users'),
            )
            expect(kinds).toContain('create-table:users')
            // an orphan log with no table at all is simply dropped
            yield* DbAdapter.actions.migrate([
              {
                kind: 'create-table',
                table: {
                  name: '__changes_ghost',
                  columns: [
                    {
                      name: 'token',
                      kind: 'text',
                      optional: false,
                      hasDefault: false,
                      enumValues: null,
                      system: false,
                      primary: true,
                    },
                  ],
                  indexes: [],
                },
              },
            ])
            expect((yield* Db.actions.planMigration()).steps).toContainEqual({
              kind: 'drop-table',
              table: '__changes_ghost',
            })
            yield* Db.actions.migrate()
            expect(yield* DbAdapter.actions.tables()).not.toContain('__changes_ghost')
          })
        }),
      )
    })

    it('since: answered by the change log — skip, recompute, snapshot', async () => {
      unwrap(
        await run(function* () {
          yield* target.install()
          yield* install(BunIO)
          // a tiny replay window so "older than the window" is reachable in a test
          const db = yield* install(DbClient, {
            tables: [users, posts],
            migrations: 'manual',
            replayWindowMs: 10,
          })
          yield* Db.actions.dropTable('posts')
          yield* Db.actions.dropTable('users')
          yield* Db.actions.migrate()
          const ada = (yield* db.insert('users', { name: 'ada' })) as AnyType
          const current = db.version('users')

          // current and older than the replay window → no initial emission at all
          yield* sleep(30)
          const silent = yield* db.query('users').watch({ since: current })
          const nothing = yield* race([
            silent.next(),
            (function* () {
              yield* sleep(50)
              return 'quiet' as const
            })(),
          ])
          expect(nothing).toBe('quiet')
          yield* db.insert('users', { name: 'grace' })
          const woke = yield* silent.next()
          expect((woke.value as AnyType).rows).toHaveLength(2)

          // a change after `since` (even one with an OLDER token, if it committed later) → emit
          const resumed = yield* db.query('users').watch({ since: current })
          const first = yield* resumed.next()
          expect((first.value as AnyType).rows).toHaveLength(2)

          // compacted past `since` → full snapshot
          yield* db.patch('users', String(ada._id), { age: 9 })
          yield* Db.actions.compact('users', { keep: 1 })
          const reset = yield* db.query('users').watch({ mode: 'delta', since: current })
          const full = yield* reset.next()
          expect((full.value as AnyType).added).toHaveLength(2)

          // garbage → snapshot, not a failure
          const junk = yield* db.query('users').watch({ since: 'not-a-token' })
          expect(((yield* junk.next()).value as AnyType).rows).toHaveLength(2)
        }),
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
