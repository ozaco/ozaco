import type { Adapter, Spec } from 'db:core'
import { adapterDefaults, DbAdapter } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, ensure, until } from 'std:effect'

import { Pool } from 'pg'

import pkg from '../../../package.json'
import { sqlActions } from '../shared/actions'
import { postgresDialect } from '../shared/dialects'
import { runSqlTransaction } from '../shared/transaction'

import { exec, StateRef, transactional } from './internal'
import type { Pg } from './types'

/** The advisory-lock key every ozaco migrate takes. Advisory locks are scoped to the CONNECTED
 * database, so a constant serializes concurrent boots against one database without coupling
 * unrelated ones. */
const MIGRATE_LOCK = 727_270_001

const sql = sqlActions({ dialect: postgresDialect, exec })

/**
 * Postgres adapter over node-postgres (`pg.Pool`) — `install(PgAdapter, { url })`, then
 * `DbClient`. The driver's own pool manages connections; transactions pin one client for their
 * duration (nested calls become savepoints). Plain write-through storage like every adapter:
 * change tracking is the core's (see the `Db` change log), nothing backend-specific.
 */
export const PgAdapter = DbAdapter.implement<Adapter.Options, [options: Pg.Options]>({
  name: 'pg',
  version: pkg.version,
  description: 'Postgres adapter over node-postgres',

  *setup(options) {
    const pool = new Pool({
      connectionString: options.url,
      max: options.max ?? 10,
      ssl: options.ssl,
    })
    yield* StateRef.set({ pool, connection: { url: options.url, ssl: options.ssl } })
    yield* ensure(function* () {
      yield* attempt(until(pool.end() as Promise<void>))
    })
    return { adapter: 'pg', capabilities: { transactions: true, raw: true, alterColumn: true } }
  },
}).build({
  ...adapterDefaults('pg'),
  ...sql,

  // two nodes booting against ONE database race the reconcile DDL — a transaction-scoped
  // advisory lock serializes them: the first creates, the rest see "already there" and pass
  // (`xact` variant: auto-released at commit/rollback, no unlock bookkeeping, and lock + DDL
  // provably share one connection)
  *migrate(steps: readonly Spec.Step[]) {
    yield* runSqlTransaction(transactional, function* () {
      yield* exec(`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK})`, [])
      yield* sql.migrate(steps)
    })
  },

  *transaction(body: () => Operation<unknown>) {
    return yield* runSqlTransaction(transactional, body)
  },
})
