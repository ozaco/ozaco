import type { Adapter } from 'db:core'
import { adapterDefaults, DbAdapter } from 'db:core'
import type { Operation } from 'std:effect'
import { ensure } from 'std:effect'

import { Database } from 'bun:sqlite'

import { sqlActions } from '../shared/actions'
import { sqliteDialect } from '../shared/dialects'
import { runSqlTransaction } from '../shared/transaction'

import { createLock, exec, StateRef, transactional } from './internal'
import type { Sqlite } from './types'

/**
 * SQLite adapter over `bun:sqlite` — `install(SqliteAdapter, { path })`, then `DbClient`. The
 * handle closes with its scope. Transactions serialize on the single shared handle (nested calls
 * become savepoints).
 */
export const SqliteAdapter = DbAdapter.implement<Adapter.Options, [options?: Sqlite.Options]>({
  name: 'sqlite',
  version: '0.1.0',
  description: 'SQLite adapter over bun:sqlite',

  *setup(options) {
    const db = new Database(options?.path ?? ':memory:')
    yield* StateRef.set({ db, lock: createLock() })
    yield* ensure(() => {
      db.close()
    })
    return {
      adapter: 'sqlite',
      capabilities: { transactions: true, raw: true, alterColumn: false },
    }
  },
}).build({
  ...adapterDefaults('sqlite'),
  ...sqlActions({ dialect: sqliteDialect, exec }),

  *transaction(body: () => Operation<unknown>) {
    return yield* runSqlTransaction(transactional, body, 'BEGIN IMMEDIATE')
  },
})
