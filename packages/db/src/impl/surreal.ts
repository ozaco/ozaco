// oxlint-disable import/exports-last
import type { DriverConnection, Query, ResolvedClientConfiguration } from 'db:core'
import { DbDriver } from 'db:core'
import { attempt, call, operation, until } from 'std:effect'
import { isSuccess } from 'std:result'

import { IO } from '@ozaco/std/io'
import type { AnyType } from '@ozaco/std/shared'
// oxlint-disable-next-line import/no-namespace
import * as surrealCore from 'surrealdb'

import { arraySubscription, dynamicImport, mapResult } from './utils/common'
import { firstResultSet, toSurreal } from './utils/surreal'

// `surrealdb` is imported statically so the driver is traceable by bundlers (incl. `bun build
// --compile`); the embedded `@surrealdb/node` engine stays an optional dynamic import.
const core = surrealCore as AnyType

/** SurrealDB-specific connection details (Postgres configs don't carry these) — supplied at install:
 * `install(SurrealDriver, { namespace, database, auth? })`. */
export interface SurrealDriverOptions {
  readonly namespace: string
  readonly database: string
  readonly auth?: Record<string, unknown>
}

let driverOptions: SurrealDriverOptions | null = null

/**
 * SurrealDB driver plugin — `install(SurrealDriver, { namespace, database })` then
 * `install(Pool, { connectionUri })`. `surrealdb` is imported statically. Postgres-specific features
 * degrade: SQLSTATE classification / COPY / LISTEN don't apply, and `$n` placeholders are rewritten to
 * SurrealQL `$pn`. `stream()` buffers: SurrealDB's SDK has no server-side cursor for a SELECT (LIVE is
 * a change-subscription primitive, not row streaming — the realtime layer's `changes` signal uses it).
 */
export const SurrealDriver = DbDriver.implement({
  name: 'surreal',
  version: '0.0.1',
  *setup(options: SurrealDriverOptions) {
    driverOptions = options
    return { dialect: 'surreal' as const }
  },
}).build({
  connect: operation(function* (config: ResolvedClientConfiguration) {
    const options = driverOptions!
    const embedded = yield* attempt(call<AnyType>(() => dynamicImport('@surrealdb/node')))
    const engines = {
      ...core.createRemoteEngines?.(),
      ...(isSuccess(embedded) ? (embedded.value as AnyType).createNodeEngines?.() : {}),
    }

    const db = new core.Surreal({ engines })
    yield* until(db.connect(config.connectionUri))
    yield* until(db.use({ namespace: options.namespace, database: options.database }))
    if (options.auth) {
      yield* until(db.signin(options.auth))
    }

    const runRaw = (query: Query) =>
      (function* () {
        const { text, bindings } = toSurreal(query)
        return firstResultSet(yield* until(db.query(text, bindings)))
      })()

    const connectionId = yield* IO.actions.uuid()
    const connection: DriverConnection = {
      connectionId,
      query: operation(function* (query: Query) {
        return mapResult(yield* runRaw(query), undefined)
      }),
      stream: operation(function* (query: Query) {
        const rows = yield* runRaw(query)
        return operation(function* () {
          return arraySubscription(rows)
        })()
      }),
      // SurrealDB has no `DISCARD ALL` equivalent; reset is a no-op.
      reset: operation(function* () {}),
      close: operation(function* () {
        yield* until(db.close())
      }),
    }
    return connection
  }),
  end: operation(function* () {}),
})
