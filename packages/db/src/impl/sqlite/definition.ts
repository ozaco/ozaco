import type { Adapter } from 'db:core'
import { adapterDefaults, DbAdapter } from 'db:core'
import type { Operation } from 'std:effect'
import { ensure } from 'std:effect'

import { Database } from 'bun:sqlite'

import pkg from '../../../package.json'
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
  version: pkg.version,
  description: 'SQLite adapter over bun:sqlite',

  *setup(options) {
    const db = new Database(options?.path ?? ':memory:')

    // writes WAIT for a competing connection instead of failing on the spot…
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options?.busyTimeoutMs ?? 5000))}`)

    // …and under WAL another process's reads never block them at all (NORMAL sync is the
    // standard WAL pairing — durable at checkpoint, far fewer fsyncs)
    if (options?.wal !== false) {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
    }

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
