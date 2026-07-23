import {
  Benchmarking,
  FieldNameTransformation,
  Pool,
  QueryCache,
  QueryLogging,
  sql,
  usePool,
} from 'db:core'
import { main } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { SqliteDriver } from 'db:impl/sqlite'
import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

/**
 * The core `@ozaco/db` client (the Slonik port) with its official interceptors — no realtime layer.
 * Interceptors are framework PLUGINS: install them BEFORE the pool and each registers itself, so the
 * pool collects them and the engine runs the hooks in Slonik's order:
 *
 * - `FieldNameTransformation` renames snake_case result columns to camelCase (`full_name` →
 *   `fullName`), so the query below selects snake_case but the rows come back camelCased.
 * - `Benchmarking` times every query; `QueryLogging` logs the lifecycle through `std:logger`.
 * - `QueryCache` serves a `-- @cache-ttl`-marked query from cache on repeat (shown at the end); its
 *   key is built with the installed codec (`JsonCodec`), not hand-rolled JSON.
 *
 * Output goes through the framework logger (no `console`); serialization through the codec.
 */
await main(function* () {
  const timings: string[] = []

  // IO (uuid), logger (query-logging + output), and codec (query-cache key) must be installed in scope
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.debug })
  yield* install(ConsoleTransport)
  yield* install(JsonCodec)
  // interceptor plugins next — they register into the scope the pool reads at install
  yield* install(FieldNameTransformation)
  yield* install(Benchmarking, {
    onResult: ({ sql: text, durationMs }) =>
      timings.push(`${durationMs.toFixed(2)}ms · ${text.replaceAll(/\s+/gu, ' ').trim()}`),
  })
  yield* install(QueryLogging, { logValues: false })
  yield* install(QueryCache)
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })

  const pool = yield* usePool()

  yield* pool.query(sql`
    CREATE TABLE app_user (
      user_id    INTEGER PRIMARY KEY,
      full_name  TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  yield* pool.query(sql`
    INSERT INTO app_user (user_id, full_name, created_at)
    VALUES (1, 'Ada Lovelace', 1), (2, 'Alan Turing', 2)
  `)

  const rows = yield* pool.any(
    sql`SELECT user_id, full_name, created_at FROM app_user ORDER BY user_id`,
  )

  // Columns were selected snake_case, but arrive camelCased via the transformation interceptor.
  yield* Logger.actions.info('rows (keys camelCased by field-name-transformation)', {
    keys: Object.keys(rows[0] ?? {}),
    rows,
  })
  yield* Logger.actions.info('benchmarks', { timings })

  // query-cache: the `-- @cache-ttl` marker makes the count query cache for 60s. Inserting a row
  // between the two identical calls proves the second is served stale from cache (no re-query).
  const countUsers = sql`SELECT COUNT(*) AS total FROM app_user -- @cache-ttl 60`
  const firstCount = yield* pool.oneFirst(countUsers)
  yield* pool.query(
    sql`INSERT INTO app_user (user_id, full_name, created_at) VALUES (3, 'Grace Hopper', 3)`,
  )
  const secondCount = yield* pool.oneFirst(countUsers)
  yield* Logger.actions.info('cached count (second is stale → cache hit)', {
    first: firstCount,
    second: secondCount,
  })

  yield* Pool.actions.close()
})
