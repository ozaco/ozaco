import { call, createContext } from 'std:effect'

import { and, asc, desc, eq } from 'drizzle-orm'

import { DB } from '../../definition'
import { applyMigrations } from '../../utils/migration/apply'
import type { DrizzleRuntime } from '../internal/drizzle-base'
import { createQueryBuilder } from '../internal/drizzle-ops'

import { classifySqliteError } from './internal/classify'
import { buildSqliteTables } from './internal/columns'
import type { SqliteBinding } from './internal/host'
import { connectSqlite } from './internal/host'
import type { SqliteConfig } from './types'

export const SqliteStateRef = createContext<SqliteBinding>('db:impl:sqlite:state')

export const SqliteImpl = DB.implement({
  name: 'sqlite',
  version: '0.0.1',
  *setup(config: SqliteConfig) {
    const source = config.url.startsWith('file:') ? config.url.slice('file:'.length) : config.url
    const drizzleTables = buildSqliteTables(config.schema)

    const binding = yield* connectSqlite(source, drizzleTables)

    const execRaw = (query: string, params: unknown[] = []): Promise<unknown[]> => {
      const stmt = binding.raw.prepare(query)
      return Promise.resolve(stmt.all(...(params as never[])))
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
      classify: classifySqliteError,
    }

    return createQueryBuilder(runtime, config.schema)
  },
})
