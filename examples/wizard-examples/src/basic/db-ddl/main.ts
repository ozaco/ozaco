import { Pool, usePool } from 'db:core'
import { DB, RealtimeDb, table, useDatabase } from 'db:realtime'
import { attempt, main } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { PgDriver } from 'db:impl/pg'
import { SqliteDriver } from 'db:impl/sqlite'
import { SurrealDriver } from 'db:impl/surreal'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * Portable DDL + DML lifecycle across ALL THREE backends. Pick the driver with `DRIVER`:
 *   - `sqlite`   (default) — embedded `:memory:`
 *   - `surreal`  — embedded SurrealDB `mem://`
 *   - `postgres` — a real server, `PG_URL` or postgres://ozaco:ozaco@localhost:55432/ozaco
 * All three run the exact same sequence:
 *
 *   create table + indexes (auto-migrate) → insert rows → get row → count → reindex → drop index →
 *   drop table → confirm the table is gone
 *
 * The `reindex`/`dropIndex`/`dropTable` operations are `DB.actions.*` (imperative), dialect-portable:
 * Postgres/SQLite emit ANSI `DROP …`/`REINDEX …`; SurrealDB emits `REMOVE …`/`REBUILD INDEX …`.
 */
const notes = table('notes', { title: z.string(), done: z.boolean().default(false) })
  .index('by_title', ['title'])
  .unique('uq_title', ['title'])

const driver = process.env.DRIVER ?? 'sqlite'
const pgUrl = process.env.PG_URL ?? 'postgres://ozaco:ozaco@localhost:55432/ozaco'

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.info })
  yield* install(ConsoleTransport)
  if (driver === 'surreal') {
    yield* install(SurrealDriver, { namespace: 'demo', database: 'demo' })
    yield* install(Pool, { connectionUri: 'mem://' })
  } else if (driver === 'postgres') {
    yield* install(PgDriver)
    yield* install(Pool, { connectionUri: pgUrl })
  } else {
    yield* install(SqliteDriver)
    yield* install(Pool, { connectionUri: ':memory:' })
  }
  // auto-migrate: CREATE/DEFINE TABLE + the two declared indexes
  yield* install(RealtimeDb, { tables: [notes] })

  yield* Logger.actions.info(`driver = ${driver} — table + indexes created`)

  const db = yield* useDatabase([notes])

  // create row / get row
  const first = yield* db.insert('notes', { title: 'write docs' })
  yield* db.insert('notes', { title: 'ship it', done: true })
  const fetched = yield* db.get('notes', first._id)
  yield* Logger.actions.info(`created + fetched row: ${fetched?._id} "${fetched?.title}"`)

  // query / count
  const count = yield* db.query('notes').count()
  const done = yield* db.query('notes').where({ done: true }).collect()
  yield* Logger.actions.info(`count=${count}, done=${done.length}`)

  // reindex → drop index → drop table (all portable across dialects)
  yield* DB.actions.reindex('notes')
  yield* Logger.actions.info('reindexed table')
  yield* DB.actions.dropIndex('notes', 'by_title')
  yield* Logger.actions.info('dropped index by_title')
  yield* DB.actions.dropTable('notes')
  yield* Logger.actions.info('dropped table')

  // confirm it's gone: a read now fails (postgres/sqlite) or returns nothing (surreal schemaless)
  const after = yield* attempt(db.query('notes').collect())
  yield* Logger.actions.info(
    `read after drop: ${isFailure(after) ? 'errored (table removed)' : `returned ${after.value.length} rows`}`,
  )

  // close the pool so the embedded SurrealDB client shuts down cleanly before exit
  yield* (yield* usePool()).end()
})
