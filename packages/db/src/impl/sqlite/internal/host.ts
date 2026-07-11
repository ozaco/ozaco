import { call, withHost } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrorCode } from '../../../error-codes'
import type { DrizzleTableMap } from '../../internal/drizzle-base'

const dynamicImport = (spec: string): Promise<AnyType> =>
  // oxlint-disable-next-line no-new-func
  (Function('s', 'return import(s)') as (s: string) => Promise<AnyType>)(spec)

export interface SqliteBinding {
  readonly raw: {
    prepare: (sql: string) => { all: (...args: AnyType[]) => unknown[] }
    close: () => void
  }
  readonly db: AnyType
}

export const connectSqlite = (source: string, drizzleTables: DrizzleTableMap) =>
  withHost<SqliteBinding>({
    *bun() {
      const { Database } = yield* call<AnyType>(() => dynamicImport('bun:sqlite'))
      const { drizzle } = yield* call<AnyType>(() => dynamicImport('drizzle-orm/bun-sqlite'))
      // safeIntegers: INTEGER reads come back as BigInt so int64 values survive the driver
      // (columns.ts normalizes per column type); foreign_keys: sqlite ignores REFERENCES
      // constraints unless the pragma is on for the connection.
      const raw = new Database(source, { create: true, safeIntegers: true })
      raw.exec('PRAGMA foreign_keys = ON')
      return { raw, db: drizzle(raw, { schema: drizzleTables }) }
    },
    *node() {
      const mod = yield* call<AnyType>(() => dynamicImport('better-sqlite3'))
      const BetterSqlite3 = mod.default ?? mod
      const { drizzle } = yield* call<AnyType>(() => dynamicImport('drizzle-orm/better-sqlite3'))
      const raw = new BetterSqlite3(source)
      raw.defaultSafeIntegers(true)
      raw.pragma('foreign_keys = ON')
      return { raw, db: drizzle(raw, { schema: drizzleTables }) }
    },
    *deno() {
      return yield* fail(DbErrorCode.Driver, 'sqlite: deno runtime not yet supported')
    },
    *browser() {
      return yield* fail(DbErrorCode.Driver, 'sqlite: browser runtime not supported')
    },
  })
