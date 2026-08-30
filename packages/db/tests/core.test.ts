import type { Schema, Spec } from 'db:core'
import {
  clampLimit,
  CLEAR,
  column,
  Db,
  DbAdapter,
  DbClient,
  DbErrors,
  defineSchema,
  filterValues,
  sanitizeFilter,
  table,
  useDb,
  where,
} from 'db:core'
import { matches } from 'db:internal'
import { attempt, run } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

import { schema, users } from './helpers'

describe('core semantics (adapter-independent)', () => {
  it('runs a Standard Schema validator (zod v4) on insert', async () => {
    const people = table(
      'people',
      { name: column.text() },
      { validate: z.object({ name: z.string().min(2) }) },
    )
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [people] })
        const short = yield* attempt(db.insert('people', { name: 'a' }))
        expect(isFailure(short)).toBe(true)
        expect((short as AnyType).error).toBe(DbErrors.Validation)
        const ok = yield* db.insert('people', { name: 'ada' })
        expect((ok as AnyType).name).toBe('ada')
      }),
    )
  })

  it('CLEAR nulls an optional column in patch; a required column rejects it', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        yield* install(DbClient, { schema })
        const db = yield* useDb(schema)
        const ada = yield* db.insert('users', { name: 'ada', age: 36 })
        const cleared = yield* db.patch('users', ada._id, { age: CLEAR })
        expect(cleared?.age).toBeNull()
        const denied = yield* attempt(db.patch('users', ada._id, { name: CLEAR } as AnyType))
        expect((denied as AnyType).error).toBe(DbErrors.Validation)
      }),
    )
  })

  it('resolves a typed handle through useDb', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        yield* install(DbClient, { schema })
        const db = yield* useDb(schema)
        const doc = yield* db.insert('users', { name: 'typed' })
        // compile-time: doc is the resolved row type of `users`
        const typed: Schema.Infer<typeof users> = doc
        expect(typed.name).toBe('typed')
        expect(db.version('users')).toBe(doc._version)
      }),
    )
  })
})

describe('scoped reads and writes', () => {
  const bootstrap = function* () {
    yield* install(MemoryAdapter)
    yield* install(BunIO)
    yield* install(DbClient, { tables: [users] })
    return yield* useDb(schema)
  }

  it('reads a row outside the scope as absent', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const admin = yield* db.insert('users', { name: 'admin', role: 'admin' })
        const scope = where.eq('role', 'member')

        expect(yield* db.get('users', admin._id)).not.toBeNull()
        expect(yield* db.get('users', admin._id, { scope })).toBeNull()
      }),
    )
  })

  it('guards patch/replace/delete by the scope', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const admin = yield* db.insert('users', { name: 'admin', role: 'admin' })
        const scope = where.eq('role', 'member')

        expect(yield* db.patch('users', admin._id, { age: 9 }, { scope })).toBeNull()
        expect(yield* db.delete('users', admin._id, { scope })).toBe(false)
        expect((yield* db.get('users', admin._id))?.age ?? null).toBeNull()

        // in scope, the same writes land
        const member = yield* db.insert('users', { name: 'member' })
        expect((yield* db.patch('users', member._id, { age: 9 }, { scope }))?.age).toBe(9)
        expect(yield* db.delete('users', member._id, { scope })).toBe(true)
      }),
    )
  })

  it('reports an out-of-scope guarded write as a MISS, never a conflict', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const admin = yield* db.insert('users', { name: 'admin', role: 'admin' })
        const scope = where.eq('role', 'member')

        // a stale `ifVersion` on an in-scope row still conflicts…
        const stale = yield* attempt(
          db.patch('users', admin._id, { age: 9 }, { ifVersion: 'v:stale' }),
        )
        expect(isFailure(stale)).toBe(true)
        expect((stale as AnyType).error).toBe(DbErrors.Conflict)

        // …but outside the scope the row must not even be proven to exist
        const hidden = yield* attempt(
          db.patch('users', admin._id, { age: 9 }, { ifVersion: 'v:stale', scope }),
        )
        expect(isFailure(hidden)).toBe(false)
        expect((hidden as AnyType).value).toBeNull()
      }),
    )
  })
})

describe('scoped handle — db.scoped(filter)', () => {
  const tenants = table('tenants_rows', {
    tenant: column.text(),
    title: column.text(),
    level: column.int().default(1),
  })
  const scopedSchema = defineSchema({ tenants })

  const bootstrap = function* () {
    yield* install(MemoryAdapter)
    yield* install(BunIO)
    yield* install(DbClient, { schema: scopedSchema })
    return yield* useDb(scopedSchema)
  }

  it('narrows every read and guards every write; inserts are stamped', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const a = db.scoped(where.eq('tenant', 'a'))
        const b = db.scoped(where.eq('tenant', 'b'))

        // the scope PINS the tenant onto the insert — the value need not carry it
        const mine = yield* a.insert('tenants_rows', { tenant: 'ignored', title: 'mine' })
        expect(mine.tenant).toBe('a')
        yield* b.insert('tenants_rows', { tenant: 'b', title: 'theirs' })

        // reads: only own rows; a foreign row reads as absent
        expect((yield* a.query('tenants_rows').collect()).map(row => row.title)).toEqual(['mine'])
        const theirs = (yield* b.query('tenants_rows').first())!
        expect(yield* a.get('tenants_rows', theirs._id)).toBeNull()
        expect(yield* db.get('tenants_rows', theirs._id)).not.toBeNull()

        // writes: a foreign row is a MISS, never a conflict
        expect(yield* a.patch('tenants_rows', theirs._id, { title: 'stolen' })).toBeNull()
        expect(yield* a.delete('tenants_rows', theirs._id)).toBe(false)
        const hidden = yield* attempt(
          a.patch('tenants_rows', theirs._id, { title: 'x' }, { ifVersion: 'v:stale' }),
        )
        expect(isFailure(hidden)).toBe(false)
        expect((hidden as AnyType).value).toBeNull()

        // in-scope stale version still conflicts
        const stale = yield* attempt(
          a.patch('tenants_rows', mine._id, { title: 'x' }, { ifVersion: 'v:stale' }),
        )
        expect((stale as AnyType).error).toBe(DbErrors.Conflict)

        // replace cannot move the row out of scope — the pin overrides the value
        const replaced = yield* a.replace('tenants_rows', mine._id, {
          tenant: 'b',
          title: 'kept',
        })
        expect(replaced?.tenant).toBe('a')
      }),
    )
  })

  it('chains (AND), inherits into transactions and scopes upsert + doc watch', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const a = db.scoped(where.eq('tenant', 'a'))

        // upsert under a scope: insert branch stamps, patch branch stays in scope
        const created = yield* a.upsert('tenants_rows', { title: 'up' }, { tenant: 'x' })
        expect(created.tenant).toBe('a')
        const updated = yield* a.upsert('tenants_rows', { title: 'up' }, { level: 5 })
        expect(updated._id).toBe(created._id)
        expect(updated.level).toBe(5)

        // chained scope ANDs — level>3 now hides the row from reads
        const narrow = a.scoped(where.gt('level', 10))
        expect(yield* narrow.get('tenants_rows', created._id)).toBeNull()

        // transactions inherit the scope
        yield* a.transaction(function* (tx) {
          const row = yield* tx.insert('tenants_rows', { tenant: 'zzz', title: 'tx' })
          expect(row.tenant).toBe('a')
        })

        // doc watch under a foreign scope reads absent
        const b = db.scoped(where.eq('tenant', 'b'))
        const feed = yield* b.watch('tenants_rows', created._id)
        expect((yield* feed.next()).value).toBeNull()
      }),
    )
  })

  it('refuses inserts under a scope that pins no exact values', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const ranged = db.scoped(where.gt('level', 3))
        const denied = yield* attempt(ranged.insert('tenants_rows', { tenant: 'a', title: 'nope' }))
        expect(isFailure(denied)).toBe(true)
        expect((denied as AnyType).error).toBe(DbErrors.Validation)

        // filterValues is the underlying rule: nested ANDs flatten, non-eq parts refuse
        expect(
          filterValues(
            where.and(where.and(where.eq('a', 1), where.isNull('b')), where.eq('c', 'x')),
          ),
        ).toEqual({ a: 1, b: null, c: 'x' })
        expect(filterValues(where.or(where.eq('a', 1), where.eq('a', 2)))).toBeNull()
      }),
    )
  })

  it('retracts the log row of a guarded write that missed — no phantoms', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const row = yield* db.insert('tenants_rows', { tenant: 'a', title: 'one' })
        const before = yield* Db.actions.logStats('tenants_rows')

        // a miss on an absent id, a scoped miss, and a scoped delete miss: no log rows appear
        expect(yield* db.patch('tenants_rows', 'no-such-id', { title: 'x' })).toBeNull()
        const b = db.scoped(where.eq('tenant', 'b'))
        expect(yield* b.patch('tenants_rows', row._id, { title: 'x' })).toBeNull()
        expect(yield* b.delete('tenants_rows', row._id)).toBe(false)

        const after = yield* Db.actions.logStats('tenants_rows')
        expect(after.rows).toBe(before.rows)

        // a write that LANDS still logs
        yield* db.patch('tenants_rows', row._id, { title: 'two' })
        expect((yield* Db.actions.logStats('tenants_rows')).rows).toBe(before.rows + 1)
      }),
    )
  })
})

describe('wire-filter sanitizing', () => {
  it('rebuilds a clean filter and strips extra properties', async () => {
    unwrap(
      await run(function* () {
        const wire = JSON.parse(
          '{"op":"and","filters":[{"op":"eq","field":"role","value":"admin","junk":1},{"op":"gt","field":"age","value":30}]}',
        )
        const clean = yield* sanitizeFilter(wire, { fields: ['role', 'age'] })
        expect(clean).toEqual({
          op: 'and',
          filters: [
            { op: 'eq', field: 'role', value: 'admin' },
            { op: 'gt', field: 'age', value: 30 },
          ],
        })
        expect(matches({ role: 'admin', age: 45 }, clean as Spec.Filter)).toBe(true)
        expect(matches({ role: 'member', age: 45 }, clean as Spec.Filter)).toBe(false)
      }),
    )
  })

  it('rejects disallowed fields, operators, depths and value shapes', async () => {
    unwrap(
      await run(function* () {
        const cases: unknown[] = [
          { op: 'eq', field: 'password', value: 'x' },
          { op: 'like', field: 'name', pattern: 5 },
          { op: 'eq', field: 'name', value: { $gt: '' } },
          { op: 'raw', field: 'name', value: 1 },
          'not-an-object',
        ]
        for (const wire of cases) {
          const outcome = yield* attempt(sanitizeFilter(wire, { fields: ['name'] }))
          expect((outcome as AnyType).error).toBe(DbErrors.Validation)
        }

        const restricted = yield* attempt(
          sanitizeFilter(
            { op: 'like', field: 'name', pattern: 'a%' },
            { fields: ['name'], ops: ['eq'] },
          ),
        )
        expect((restricted as AnyType).error).toBe(DbErrors.Validation)

        let deep: Record<string, unknown> = { op: 'eq', field: 'name', value: 'x' }
        for (let index = 0; index < 12; index += 1) {
          deep = { op: 'not', filter: deep }
        }
        const nested = yield* attempt(sanitizeFilter(deep, { fields: ['name'] }))
        expect((nested as AnyType).error).toBe(DbErrors.Validation)
      }),
    )
  })

  it('array ops speak `value` (and still accept the legacy `values` key on the wire)', async () => {
    unwrap(
      await run(function* () {
        const canonical = yield* sanitizeFilter(
          { op: 'in', field: 'role', value: ['admin', 'member'] },
          { fields: ['role'] },
        )
        expect(canonical).toEqual({ op: 'in', field: 'role', value: ['admin', 'member'] })
        expect(matches({ role: 'admin' }, canonical as Spec.Filter)).toBe(true)

        const legacy = yield* sanitizeFilter(
          { op: 'not-in', field: 'role', values: ['admin'] },
          { fields: ['role'] },
        )
        expect(legacy).toEqual({ op: 'not-in', field: 'role', value: ['admin'] })
        expect(matches({ role: 'member' }, legacy as Spec.Filter)).toBe(true)

        const bad = yield* attempt(
          sanitizeFilter({ op: 'in', field: 'role', value: 'admin' }, { fields: ['role'] }),
        )
        expect((bad as AnyType).error).toBe(DbErrors.Validation)
      }),
    )
  })

  it('clamps untrusted limits', () => {
    expect(clampLimit(10, 100)).toBe(10)
    expect(clampLimit(1000, 100)).toBe(100)
    expect(clampLimit(-5, 100)).toBe(1)
    expect(clampLimit('nope', 100)).toBe(1)
    expect(clampLimit(2.9, 100)).toBe(2)
  })
})

describe('adapter middleware', () => {
  it('DbAdapter.around wraps the data plane (the metrics/tracing seam)', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [users] })
        const seen: string[] = []
        yield* DbAdapter.around({
          find: ([spec]: AnyType[], next: AnyType) =>
            (function* () {
              seen.push(`find:${spec.table.name}`)
              return yield* next(spec)
            })(),
        })
        yield* db.insert('users', { name: 'ada' })
        const rows = yield* db.query('users').filter(where.gt('age', -1)).collect()
        expect(rows).toHaveLength(0)
        expect(seen).toEqual(['find:users'])
      }),
    )
  })
})
