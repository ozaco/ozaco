import { call, createContext, operation, useContext, withHost } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { and, asc, desc, eq } from 'drizzle-orm'

import { DB } from '../core'
import { applyMigrations } from '../migration/apply'
import type { QueryBuilder } from '../query'
import type { DbError } from '../runtime'
import type { SchemaDef } from '../schema/types'

import type { DrizzleRuntime } from './internal/drizzle-base'
import { createQueryBuilder } from './internal/drizzle-ops'
import { buildPgTables } from './internal/postgres-columns'

interface PostgresBinding {
  readonly client: AnyType
  readonly db: AnyType
  readonly execRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>
  readonly close: () => Promise<void>
}

const PostgresStateRef = createContext<PostgresBinding>('db:impl:postgres:state')

const dynamicImport = (spec: string): Promise<AnyType> =>
  // oxlint-disable-next-line no-new-func
  (Function('s', 'return import(s)') as (s: string) => Promise<AnyType>)(spec)

export interface PostgresConfig {
  readonly url: string
  readonly schema: SchemaDef
  readonly max?: number
}

export const PostgresDB = DB.implement({
  name: 'postgres',
  version: '0.0.1',
  *setup(config: PostgresConfig) {
    const drizzleTables = buildPgTables(config.schema)
    const max = config.max ?? 10

    const binding = yield* withHost<PostgresBinding, DbError>({
      *bun() {
        const { SQL } = yield* call<AnyType>(() => dynamicImport('bun'))
        const { drizzle } = yield* call<AnyType>(() => dynamicImport('drizzle-orm/bun-sql'))
        const client = new SQL({ url: config.url, max })
        const db = drizzle(client, { schema: drizzleTables })
        return {
          client,
          db,
          execRaw: async (sql, params = []) => {
            const rows = await client.unsafe(sql, params as AnyType[])
            return Array.isArray(rows) ? rows : []
          },
          close: () => client.close(),
        }
      },
      *node() {
        const { Pool } = yield* call<AnyType>(() => dynamicImport('pg'))
        const { drizzle } = yield* call<AnyType>(() => dynamicImport('drizzle-orm/node-postgres'))
        const pool = new Pool({ connectionString: config.url, max })
        const db = drizzle(pool, { schema: drizzleTables })
        return {
          client: pool,
          db,
          execRaw: (sql, params = []) =>
            pool.query(sql, params).then((r: { rows: unknown[] }) => r.rows),
          close: () => pool.end(),
        }
      },
      *deno() {
        yield* fail('driver' as DbError, 'postgres: deno runtime not yet supported')
        throw new Error('unreachable')
      },
      *browser() {
        yield* fail('driver' as DbError, 'postgres: browser runtime not supported')
        throw new Error('unreachable')
      },
    })

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
    }

    return createQueryBuilder(runtime, config.schema) as QueryBuilder & Record<string, AnyType>
  },
}).build({
  close: operation(function* () {
    const state = yield* useContext(PostgresStateRef)
    yield* call(() => state.close())
  }),
})
