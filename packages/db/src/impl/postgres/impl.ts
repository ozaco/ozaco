import { call, createContext } from 'std:effect'

import { and, asc, desc, eq } from 'drizzle-orm'

import { DB } from '../../definition'
import { applyMigrations } from '../../utils/migration/apply'
import type { DrizzleRuntime } from '../internal/drizzle-base'
import { createQueryBuilder } from '../internal/drizzle-ops'

import { classifyPostgresError } from './internal/classify'
import { buildPgTables } from './internal/columns'
import type { PostgresBinding } from './internal/host'
import { connectPostgres } from './internal/host'
import type { PostgresConfig } from './types'

export const PostgresStateRef = createContext<PostgresBinding>('db:impl:postgres:state')

export const PostgresImpl = DB.implement({
  name: 'postgres',
  version: '0.0.1',
  *setup(config: PostgresConfig) {
    const drizzleTables = buildPgTables(config.schema)
    const max = config.max ?? 10

    const binding = yield* connectPostgres(config.url, max, drizzleTables)

    yield* call(() => applyMigrations(binding.execRaw, config.schema, 'postgres'))

    yield* PostgresStateRef.set(binding)

    const runtime: DrizzleRuntime = {
      db: binding.db,
      tables: drizzleTables,
      and: (...conditions) => and(...conditions),
      eq: (column, value) => eq(column, value),
      asc: column => asc(column),
      desc: column => desc(column),
      execRaw: binding.execRaw,
      classify: classifyPostgresError,
    }

    return createQueryBuilder(runtime, config.schema)
  },
})
