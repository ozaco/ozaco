import { Pool } from 'db:core'
import { DB, RealtimeDb, table, useDatabase } from 'db:realtime'
import { attempt, main } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { SqliteDriver } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * Manual migration.
 *
 * By default `RealtimeDb` reconciles the schema at install (`migrations: 'auto'`). With
 * `migrations: 'manual'` the schema is registered but NOT applied — YOU decide when. The flow is:
 *
 *   1. `DB.actions.planMigration()` → preview the pending DDL (each statement's kind + SQL, and whether
 *      it is destructive) so you can review it before touching the database.
 *   2. `DB.actions.migrate()` → apply it when ready.
 *
 * `safe: true` makes destructive steps (DROP COLUMN) get SKIPPED on apply — a guard for production.
 *
 * NOTE: column add/drop diffs require a backend the planner can introspect (Postgres via
 * `information_schema`). On SQLite (used here so the example runs with no external services) the plan
 * is always `CREATE TABLE / INDEX IF NOT EXISTS`, so re-planning after a migrate is a harmless no-op
 * rather than empty. The manual gate + preview + apply flow is identical on every backend.
 */
const users = table('users', {
  name: z.string(),
  email: z.string(),
  age: z.number().int().optional(),
}).index('users_by_email', ['email'])

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.info })
  yield* install(ConsoleTransport)
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  // manual: the `users` schema is registered but the table is NOT created at install.
  yield* install(RealtimeDb, { tables: [users], migrations: 'manual', safe: true })

  const db = yield* useDatabase([users])

  // 1) the manual gate — nothing has been migrated yet, so the table does not exist.
  const before = yield* attempt(db.query('users').collect())
  yield* Logger.actions.info(
    `before migrate → query users: ${isFailure(before) ? 'no table yet (as expected)' : 'UNEXPECTED success'}`,
  )

  // 2) preview the pending migration and review each statement.
  const plan = yield* DB.actions.planMigration()
  yield* Logger.actions.info(`planMigration → ${plan.statements.length} statement(s):`)
  for (const statement of plan.statements) {
    yield* Logger.actions.info(
      `  · ${statement.kind}${statement.destructive ? ' (destructive → skipped when safe)' : ''}: ${statement.sql}`,
    )
  }

  // 3) apply it, on your terms.
  yield* DB.actions.migrate()
  yield* Logger.actions.info('migrate → applied')

  // 4) the schema now exists — writes and reads work.
  yield* db.insert('users', { name: 'Ada', email: 'ada@example.com', age: 36 })
  yield* db.insert('users', { name: 'Linus', email: 'linus@example.com' })
  const rows = yield* db.query('users').collect()
  yield* Logger.actions.info(
    `after migrate → ${rows.length} user(s): ${rows.map(row => row.name).join(', ')}`,
  )

  // 5) re-planning is safe (every statement is IF NOT EXISTS), so running migrate again is a no-op.
  const replan = yield* DB.actions.planMigration()
  yield* Logger.actions.info(
    `re-plan → ${replan.statements.length} statement(s) (IF NOT EXISTS, no-op)`,
  )
})
