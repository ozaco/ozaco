import { call, createContext, operation, useContext, withHost } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { and, asc, desc, eq } from 'drizzle-orm'

import { DB } from '../core'
import { applyMigrations } from '../migration/apply'
import type { DbError } from '../runtime'
import type { SchemaDef } from '../schema/types'

import type { DrizzleRuntime } from './internal/drizzle-base'
import { createQueryBuilder } from './internal/drizzle-ops'
import { buildSqliteTables } from './internal/sqlite-columns'

interface SqliteBinding {
  readonly raw: {
    prepare: (sql: string) => { all: (...args: AnyType[]) => unknown[] }
    close: () => void
  }
  readonly db: AnyType
}

const SqliteStateRef = createContext<SqliteBinding>('db:impl:sqlite:state')

const dynamicImport = (spec: string): Promise<AnyType> =>
  // oxlint-disable-next-line no-new-func
  (Function('s', 'return import(s)') as (s: string) => Promise<AnyType>)(spec)

export interface SqliteConfig {
  readonly url: string
  readonly schema: SchemaDef
}

export const SqliteDB = DB.implement({
  name: 'sqlite',
  version: '0.0.1',
  *setup(config: SqliteConfig) {
    const source = config.url.startsWith('file:') ? config.url.slice('file:'.length) : config.url
    const drizzleTables = buildSqliteTables(config.schema)

    const binding = yield* withHost<SqliteBinding, DbError>({
      *bun() {
        const { Database } = yield* call<AnyType>(() => dynamicImport('bun:sqlite'))
        const { drizzle } = yield* call<AnyType>(() => dynamicImport('drizzle-orm/bun-sqlite'))
        const raw = new Database(source, { create: true })
        return { raw, db: drizzle(raw, { schema: drizzleTables }) }
      },
      *node() {
        const mod = yield* call<AnyType>(() => dynamicImport('better-sqlite3'))
        const BetterSqlite3 = mod.default ?? mod
        const { drizzle } = yield* call<AnyType>(() => dynamicImport('drizzle-orm/better-sqlite3'))
        const raw = new BetterSqlite3(source)
        return { raw, db: drizzle(raw, { schema: drizzleTables }) }
      },
      *deno() {
        return yield* fail('driver' as DbError, 'sqlite: deno runtime not yet supported')
      },
      *browser() {
        return yield* fail('driver' as DbError, 'sqlite: browser runtime not supported')
      },
    })

    const execRaw = (query: string, params: unknown[] = []): Promise<unknown[]> => {
      const stmt = binding.raw.prepare(query)
      return Promise.resolve(stmt.all(...(params as AnyType[])))
    }

    yield* call(() => applyMigrations(execRaw, config.schema, 'sqlite'))

    yield* SqliteStateRef.set(binding)

    const runtime: DrizzleRuntime = {
      db: binding.db,
      tables: drizzleTables,
      and: (...conditions) => and(...conditions),
      eq: (column, value) => eq(column, value),
      asc: column => asc(column),
      desc: column => desc(column),
      execRaw,
    }

    return createQueryBuilder(runtime, config.schema)
  },
}).build({
  close: operation(function* () {
    const state = yield* useContext(SqliteStateRef)
    yield* call(() => {
      state.raw.close()
    })
  }),
})
