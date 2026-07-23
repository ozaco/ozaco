import type { DriverConnection, Query, QueryResultRow, ResolvedClientConfiguration } from 'db:core'
import { DbDriver } from 'db:core'
import { operation, until } from 'std:effect'

import { IO } from '@ozaco/std/io'
import type { AnyType } from '@ozaco/std/shared'
import { Client } from 'pg'

import { arraySubscription, iteratorSubscription } from './utils/common'
import { loadCopyFrom, loadQueryStream, mapPgResult } from './utils/pg'

// `pg` is imported statically so the driver is traceable by bundlers (incl. `bun build --compile`).
const PgClient = Client as AnyType

/**
 * node-postgres (`pg`) driver plugin — `install(PgDriver)` then `install(Pool, { connectionUri })`.
 * `pg` is imported statically. Each `connect()` opens a dedicated `pg.Client` (the client's own pool
 * is bypassed; the Slonik pool bounds connections). `stream()` is a REAL server-side cursor when
 * `pg-query-stream` is installed (otherwise it buffers); `copyFromBinary` needs `pg-copy-streams`.
 */
export const PgDriver = DbDriver.implement({
  name: 'pg',
  version: '0.0.1',
  *setup() {
    return { dialect: 'postgres' as const }
  },
}).build({
  connect: operation(function* (config: ResolvedClientConfiguration) {
    const QueryStream = yield* loadQueryStream()
    const copyFrom = yield* loadCopyFrom()

    const client = new PgClient({
      connectionString: config.connectionUri,
      ...(config.ssl ? { ssl: config.ssl } : {}),
      ...(config.connectionTimeout ? { connectionTimeoutMillis: config.connectionTimeout } : {}),
      ...(config.statementTimeout ? { statement_timeout: config.statementTimeout } : {}),
    })
    yield* until(client.connect())

    const connectionId = yield* IO.actions.uuid()
    const connection: DriverConnection = {
      connectionId,
      query: operation(function* (query: Query) {
        const result = yield* until(
          client.query({ text: query.sql, values: [...query.values] }) as Promise<AnyType>,
        )
        return mapPgResult(result)
      }),
      stream: operation(function* (query: Query) {
        if (QueryStream) {
          // node-`pg` returns the QueryStream itself (a Submittable / Readable) from `.query()`.
          const source = client.query(
            new QueryStream(query.sql, [...query.values]),
          ) as AsyncIterable<QueryResultRow>
          const iterator = source[Symbol.asyncIterator]()
          return operation(function* () {
            return iteratorSubscription(iterator)
          })()
        }
        const result = yield* until(
          client.query({ text: query.sql, values: [...query.values] }) as Promise<AnyType>,
        )
        const rows = (result?.rows ?? []) as readonly QueryResultRow[]
        return operation(function* () {
          return arraySubscription(rows)
        })()
      }),
      reset: operation(function* () {
        if (config.resetConnectionQuery) {
          yield* until(client.query(config.resetConnectionQuery) as Promise<AnyType>)
        }
      }),
      close: operation(function* () {
        yield* until(client.end() as Promise<AnyType>)
      }),
      // Only advertised when `pg-copy-streams` is installed — the pool checks for this method and
      // fails the call otherwise (so a missing dep degrades cleanly instead of throwing).
      ...(copyFrom
        ? {
            copyFromBinary: operation(function* (statement: string, payload: Uint8Array) {
              const sink = client.query(copyFrom(statement)) as AnyType
              yield* until(
                new Promise<void>((resolve, reject) => {
                  sink.on('error', reject)
                  sink.on('finish', () => {
                    resolve()
                  })
                  sink.end(Buffer.from(payload))
                }),
              )
            }),
          }
        : {}),
    }
    return connection
  }),
  // Clients are closed individually by the pool on release/teardown; nothing pool-wide to end.
  end: operation(function* () {}),
})
