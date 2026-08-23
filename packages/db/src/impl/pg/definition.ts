import type { Adapter } from 'db:core'
import { adapterDefaults, DbAdapter } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, ensure, until } from 'std:effect'

import { Pool } from 'pg'

import { sqlActions } from '../shared/actions'
import { postgresDialect } from '../shared/dialects'
import { runSqlTransaction } from '../shared/transaction'

import { exec, StateRef, transactional } from './internal'
import type { Pg } from './types'

/**
 * Postgres adapter over node-postgres (`pg.Pool`) — `install(PgAdapter, { url })`, then
 * `DbClient`. The driver's own pool manages connections; transactions pin one client for their
 * duration (nested calls become savepoints). Plain write-through storage like every adapter:
 * change tracking is the core's (see the `Db` change log), nothing backend-specific.
 */
export const PgAdapter = DbAdapter.implement<Adapter.Options, [options: Pg.Options]>({
  name: 'pg',
  version: '0.1.0',
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
  ...sqlActions({ dialect: postgresDialect, exec }),

  *transaction(body: () => Operation<unknown>) {
    return yield* runSqlTransaction(transactional, body)
  },
})
