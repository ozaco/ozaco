import type { DriverConnection, Query, QueryResultRow, ResolvedClientConfiguration } from 'db:core'
import { DbDriver } from 'db:core'
import { operation } from 'std:effect'

import { Database } from 'bun:sqlite'

import { IO } from '@ozaco/std/io'
import type { AnyType } from '@ozaco/std/shared'

import { iteratorSubscription, mapResult } from './utils/common'
import { encodeParam, returnsRows } from './utils/sqlite'

// SQLite is a single database (especially `:memory:`), so every pooled connection shares ONE handle —
// the pool bounds concurrency, not distinct databases. Opened lazily (the path arrives with `connect`).
let sharedDb: AnyType = null

/**
 * SQLite driver plugin over Bun's built-in `bun:sqlite` — `install(SqliteDriver)` then
 * `install(Pool, { connectionUri: ':memory:' })`. `bun:sqlite` is imported statically (bundler-visible,
 * incl. `bun build --compile`). The `sql` tag emits Postgres `$n` placeholders, rewritten to `?`;
 * params are write-encoded (booleans → 0/1, objects → JSON). `stream()` is REAL streaming via
 * `Statement.iterate()` (lazy, row-by-row). Postgres-only features (SQLSTATE/COPY/LISTEN) don't apply.
 */
export const SqliteDriver = DbDriver.implement({
  name: 'sqlite',
  version: '0.0.1',
  *setup() {
    return { dialect: 'sqlite' as const }
  },
}).build({
  connect: operation(function* (config: ResolvedClientConfiguration) {
    const path = (config.connectionUri ?? ':memory:').replace(/^(sqlite|file):/u, '') || ':memory:'
    sharedDb ??= new Database(path) as AnyType
    const db = sharedDb

    const prepare = (query: Query) => ({
      statement: db.query(query.sql.replaceAll(/\$\d+/gu, '?')),
      params: query.values.map(encodeParam),
      rows: returnsRows(query.sql),
    })

    const connectionId = yield* IO.actions.uuid()
    const connection: DriverConnection = {
      connectionId,
      query: operation(function* (query: Query) {
        const { statement, params, rows } = prepare(query)
        if (!rows) {
          statement.run(...params)
          return mapResult([], 0)
        }
        return mapResult(statement.all(...params) as readonly QueryResultRow[], undefined)
      }),
      stream: operation(function* (query: Query) {
        const { statement, params, rows } = prepare(query)
        // real, lazy row-by-row streaming — the whole result set is never materialized
        const iterator = (
          rows ? statement.iterate(...params) : [][Symbol.iterator]()
        ) as Iterator<QueryResultRow>
        return operation(function* () {
          return iteratorSubscription(iterator)
        })()
      }),
      reset: operation(function* () {}),
      // the db is shared across pooled connections; only `end()` actually closes it
      close: operation(function* () {}),
    }
    return connection
  }),
  end: operation(function* () {
    sharedDb?.close()
    sharedDb = null
  }),
})
