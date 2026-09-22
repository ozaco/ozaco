import { DbClient, column, Kv, table } from 'db:core'
import type { Operation } from 'std:effect'
import { run } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PgAdapter } from 'db:impl/pg'
import { SqliteAdapter } from 'db:impl/sqlite'
import { TableKv } from 'db:impl/table-kv'
import { BunIO } from 'std:io/impl/bun'

import { runKvSuite } from './suite'

// one sqlite FILE per test file: every install (any scope) joins the same backend
const path = join(mkdtempSync(join(tmpdir(), 'ozaco-table-kv-')), 'kv.sqlite')

const sqlite = function* (prefix = 'suite'): Operation<unknown> {
  yield* SqliteAdapter.use({ path })
  return yield* TableKv.use({ prefix })
}

runKvSuite({
  label: 'table',
  enabled: true,
  use: sqlite,
  expect: { persistent: true, atomic: false },
})

/** Set DB_TEST_PG_URL to run the same suite over Postgres rows. */
const url = process.env.DB_TEST_PG_URL

runKvSuite({
  label: 'table',
  enabled: Boolean(url),
  *use(prefix = 'suite') {
    yield* PgAdapter.use({ url: url! })
    return yield* TableKv.use({ prefix, table: '_kv_pg_suite' })
  },
  expect: { persistent: true, atomic: false },
})

describe('kv — table', () => {
  it('coexists with an application DbClient on the same adapter (its tables are never dropped)', async () => {
    const todos = table('todos', { title: column.text() })
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* SqliteAdapter.use({
          path: join(mkdtempSync(join(tmpdir(), 'ozaco-kv-app-')), 'a.sqlite'),
        })
        yield* TableKv.use({ prefix: 'app' })
        yield* Kv.actions.set('greeting', 'hello')
        // the app reconciles its own schema AFTER the kv tables exist: they are foreign to it
        const db = (yield* DbClient.use({ tables: [todos] })) as AnyType
        yield* db.insert('todos', { title: 'x' })
        expect(yield* Kv.actions.get<string>('greeting')).toBe('hello')
        expect((yield* db.query('todos').collect()).length).toBe(1)
      }),
    )
  })

  it('needs an adapter, and refuses a table name that is not an identifier', async () => {
    const bare = await run(() => TableKv.use())
    expect((bare as AnyType).error).toBe('kv.configuration')
    const badName = await run(function* () {
      yield* SqliteAdapter.use()
      return yield* TableKv.use({ table: 'kv; drop' })
    })
    expect((badName as AnyType).error).toBe('kv.configuration')
  })
})
