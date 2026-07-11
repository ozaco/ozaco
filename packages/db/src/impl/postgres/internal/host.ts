import { call, withHost } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrorCode } from '../../../error-codes'
import type { DrizzleTableMap } from '../../internal/drizzle-base'

const dynamicImport = (spec: string): Promise<AnyType> =>
  // oxlint-disable-next-line no-new-func
  (Function('s', 'return import(s)') as (s: string) => Promise<AnyType>)(spec)

export interface PostgresBinding {
  readonly client: AnyType
  readonly db: AnyType
  readonly execRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>
  readonly close: () => Promise<void>
}

export const connectPostgres = (url: string, max: number, drizzleTables: DrizzleTableMap) =>
  withHost<PostgresBinding>({
    *bun() {
      const { SQL } = yield* call<AnyType>(() => dynamicImport('bun'))
      const { drizzle } = yield* call<AnyType>(() => dynamicImport('drizzle-orm/bun-sql'))
      const client = new SQL({ url, max })
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
      const pool = new Pool({ connectionString: url, max })
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
      return yield* fail(DbErrorCode.Driver, 'postgres: deno runtime not yet supported')
    },
    *browser() {
      return yield* fail(DbErrorCode.Driver, 'postgres: browser runtime not supported')
    },
  })
