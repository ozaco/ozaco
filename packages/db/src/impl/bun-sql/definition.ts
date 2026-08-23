import type { Adapter } from 'db:core'
import { adapterDefaults, DbAdapter } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, ensure, until } from 'std:effect'

import { sqlActions } from '../shared/actions'
import { postgresDialect } from '../shared/dialects'
import { runSqlTransaction } from '../shared/transaction'

import { exec, SqlClient, StateRef, transactional } from './internal'
import type { BunSql } from './types'

/**
 * Postgres adapter over Bun's built-in `SQL` client — `install(BunSqlAdapter, { url })`, then
 * `DbClient`. Bun manages the connection pool; transactions reserve one connection for their
 * duration (nested calls become savepoints).
 */
export const BunSqlAdapter = DbAdapter.implement<Adapter.Options, [options: BunSql.Options]>({
  name: 'bun-sql',
  version: '0.1.0',
  description: 'Postgres adapter over the built-in Bun SQL client',

  *setup(options) {
    const client = new SqlClient(options.url, { max: options.max ?? 10 })
    yield* StateRef.set({ client })
    yield* ensure(function* () {
      yield* attempt(until((client.close?.() ?? client.end?.()) as Promise<void>))
    })
    return {
      adapter: 'bun-sql',
      capabilities: { transactions: true, raw: true, alterColumn: true },
    }
  },
}).build({
  ...adapterDefaults('bun-sql'),
  ...sqlActions({ dialect: postgresDialect, exec }),

  *transaction(body: () => Operation<unknown>) {
    return yield* runSqlTransaction(transactional, body)
  },
})
