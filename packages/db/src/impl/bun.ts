import type { DriverConnection, Query, QueryResultRow, ResolvedClientConfiguration } from 'db:core'
import { DbDriver } from 'db:core'
import { operation, until } from 'std:effect'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'

import { SQL } from 'bun'

import { arraySubscription, mapResult } from './utils/common'

const SqlClient = SQL as AnyType

/** Bun `SQL` driver plugin: `install(BunDriver)` then `install(Pool, { connectionUri })`.
 * Statically imports `bun`. */
export const BunDriver = DbDriver.implement({
  name: 'bun',
  version: '0.0.1',
  *setup() {
    return {
      dialect: 'postgres',
    }
  },
}).build({
  connect: operation(function* (config: ResolvedClientConfiguration) {
    const client = new SqlClient(config.connectionUri, { max: 1 })

    const runRaw = (query: Query) =>
      until(client.unsafe(query.sql, [...query.values]) as Promise<AnyType>)

    const connectionId = yield* IO.actions.uuid()
    const connection: DriverConnection = {
      connectionId,
      query: operation(function* (query: Query) {
        const result = yield* runRaw(query)
        const rows = (Array.isArray(result) ? result : []) as readonly QueryResultRow[]
        return mapResult(rows, (result as AnyType)?.count)
      }),
      stream: operation(function* (query: Query) {
        const result = yield* runRaw(query)
        const rows = (Array.isArray(result) ? result : []) as readonly QueryResultRow[]
        return operation(function* () {
          return arraySubscription(rows)
        })()
      }),
      reset: operation(function* () {
        if (config.resetConnectionQuery) {
          yield* until(client.unsafe(config.resetConnectionQuery) as Promise<AnyType>)
        }
      }),
      close: operation(function* () {
        yield* until((client.close?.() ?? client.end?.()) as Promise<AnyType>)
      }),
    }
    return connection
  }),

  end: operation(function* () {}),
})
