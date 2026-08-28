import { column, Db, DbClient, DbErrors, table } from 'db:core'
import { isDestructive } from 'db:internal'
import { attempt, run } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryAdapter } from 'db:impl/memory'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

import { users } from './helpers'

describe('migrations — plan and apply', () => {
  it('auto migration reconciles at install; the follow-up plan is index-only', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        yield* install(DbClient, { tables: [users] })
        const plan = yield* Db.actions.planMigration()
        const structural = plan.steps.filter((step: AnyType) => step.kind !== 'create-index')
        expect(structural).toEqual([])
      }),
    )
  })

  it("migrations: 'manual' defers table creation to Db.actions.migrate()", async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [users], migrations: 'manual' })

        const before = yield* attempt(db.query('users').collect())
        expect(isFailure(before)).toBe(true)
        expect((before as AnyType).error).toBe(DbErrors.Query)

        yield* Db.actions.migrate()
        expect(yield* db.query('users').collect()).toEqual([])
      }),
    )
  })

  it('evolves a persisted sqlite schema: add-column applied, drop-column gated by safe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-db-'))
    const path = join(dir, 'evolve.sqlite')
    const v1 = table('items', { a: column.text(), extra: column.text().optional() })
    const v2 = table('items', { a: column.text(), b: column.int().optional() })

    try {
      unwrap(
        await run(function* () {
          yield* install(SqliteAdapter, { path })
          yield* install(BunIO)
          const db = yield* install(DbClient, { tables: [v1] })
          yield* db.insert('items', { a: 'one', extra: 'keep?' })
        }),
      )

      // same file, new schema, safe mode: `b` added, `extra` NOT dropped
      unwrap(
        await run(function* () {
          yield* install(SqliteAdapter, { path })
          yield* install(BunIO)
          const db = yield* install(DbClient, { tables: [v2], migrations: 'manual', safe: true })

          const plan = yield* Db.actions.planMigration()
          const kinds = plan.steps.map((step: AnyType) => step.kind)
          expect(kinds).toContain('add-column')
          expect(kinds).toContain('drop-column')
          expect(plan.steps.some((step: AnyType) => isDestructive(step))).toBe(true)

          yield* Db.actions.migrate()
          const rows = yield* Db.actions.raw('SELECT * FROM "items"')
          expect(rows.rows[0]).toHaveProperty('extra', 'keep?')
          expect(rows.rows[0]).toHaveProperty('b', null)

          const row = yield* db.query('items').first()
          expect((row as AnyType).a).toBe('one')
        }),
      )

      // safe off: the undeclared column is dropped
      unwrap(
        await run(function* () {
          yield* install(SqliteAdapter, { path })
          yield* install(BunIO)
          yield* install(DbClient, { tables: [v2] })
          const rows = yield* Db.actions.raw('SELECT * FROM "items"')
          expect(rows.rows[0]).not.toHaveProperty('extra')
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imperative DDL: dropTable / dropIndex / reindex', async () => {
    unwrap(
      await run(function* () {
        yield* install(SqliteAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [users] })
        yield* db.insert('users', { name: 'ada' })

        yield* Db.actions.reindex('users')
        yield* Db.actions.dropIndex('users', 'by_name')
        // the unique index is gone — the duplicate now inserts cleanly
        yield* db.insert('users', { name: 'ada' })
        expect(yield* db.query('users').count()).toBe(2)

        yield* Db.actions.dropTable('users')
        const after = yield* attempt(db.query('users').collect())
        expect(isFailure(after)).toBe(true)
      }),
    )
  })
})
