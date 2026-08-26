import type { Schema, Spec } from 'db:core'
import {
  clampLimit,
  CLEAR,
  column,
  DbAdapter,
  DbClient,
  DbErrors,
  gt,
  matches,
  sanitizeFilter,
  table,
  useDb,
} from 'db:core'
import { attempt, run } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

import { posts, users } from './helpers'

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
        yield* install(DbClient, { tables: [users] })
        const db = yield* useDb(users)
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
        yield* install(DbClient, { tables: [users, posts] })
        const db = yield* useDb(users, posts)
        const doc = yield* db.insert('users', { name: 'typed' })
        // compile-time: doc is the resolved row type of `users`
        const typed: Schema.Infer<typeof users> = doc
        expect(typed.name).toBe('typed')
        expect(db.version('users')).toBe(doc._version)
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
        const rows = yield* db.query('users').filter(gt('age', -1)).collect()
        expect(rows).toHaveLength(0)
        expect(seen).toEqual(['find:users'])
      }),
    )
  })
})
