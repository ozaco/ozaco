// oxlint-disable import/exports-last
import type { DriverConnection, Query, ResolvedClientConfiguration } from 'db:core'
import { DbDriver } from 'db:core'
import { attempt, call, operation, sleep, until } from 'std:effect'
import { isSuccess } from 'std:result'

import { IO } from '@ozaco/std/io'
import type { AnyType } from '@ozaco/std/shared'
// oxlint-disable-next-line import/no-namespace
import * as surrealCore from 'surrealdb'

import { arraySubscription, dynamicImport, mapResult } from './utils/common'
import { escapeIdent, firstResultSet, toSurreal } from './utils/surreal'

// The dialect degrade layer, exported for tests and for debugging what a query becomes on Surreal.
export { toSurreal } from './utils/surreal'

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

// SurrealDB's embedded engines (`mem://`, `surrealkv://`) scope the database to the `Surreal` CLIENT
// instance — a fresh client per pooled connection would be a fresh, EMPTY database, so a write on one
// connection is invisible to the next. Mirror the SQLite driver: every pooled connection shares ONE
// client (the pool bounds concurrency, not distinct databases). Opened lazily on the first `connect`,
// closed only by `end()`.
let sharedDb: AnyType = null

/**
 * SurrealDB driver plugin — `install(SurrealDriver, { namespace, database })` then
 * `install(Pool, { connectionUri })`. `surrealdb` is imported statically. Postgres-specific features
 * degrade: SQLSTATE classification / COPY / LISTEN don't apply, and `$n` placeholders are rewritten to
 * SurrealQL `$pn`. `stream()` buffers: SurrealDB's SDK has no server-side cursor for a SELECT (LIVE is
 * a change-subscription primitive, not row streaming — the realtime layer's `changes` signal uses it).
 *
 * When targeting a remote server, its major version must match the embedded engine's
 * (`@surrealdb/node` 3.x ↔ server 3.x) — mixed majors fail in subtle ways (a v2 server can't even
 * answer a v3-shaped `count()`).
 *
 * Two embedded-engine caveats, neither of which affects this driver's own paths:
 * - The SDK's collection helpers (`db.insert(table, rows)`, …) are broken against embedded v3
 *   engines — they die with `Cannot execute INSERT statement using value: '<table>'`. This driver
 *   only ever issues raw `db.query(...)` (inserts arrive as compiled SurrealQL), so it never hits
 *   this; anyone reaching for the shared client directly must stick to `query` too.
 * - `@surrealdb/node` PANICS if the process exits while the engine is still OPEN (SIGTRAP →
 *   exit 133/139), and an open engine also pins the event loop, so a natural exit never comes —
 *   the only way out of an unclosed engine is a `process.exit()` that then panics. A clean
 *   `close()` before exit prevents it deterministically (measured: close → 0, no close → 133,
 *   every run). The Pool guarantees this via scope teardown (`ensure` → `end()`), so the ONLY
 *   remaining hazard is calling `process.exit()` from inside the scope, before teardown ran.
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
    if (!sharedDb) {
      const embedded = yield* attempt(call<AnyType>(() => dynamicImport('@surrealdb/node')))
      const engines = {
        ...core.createRemoteEngines?.(),
        ...(isSuccess(embedded) ? (embedded.value as AnyType).createNodeEngines?.() : {}),
      }

      const db = new core.Surreal({ engines })
      yield* until(db.connect(config.connectionUri))
      // root/ns credentials FIRST — the DEFINEs below need them; a future record/scope-auth
      // payload carries its own ns/db, so signing in before `use` stays correct either way.
      if (options.auth) {
        yield* until(db.signin(options.auth))
      }
      // SurrealDB 3.x errors on `use` of a missing namespace/database (2.x created them lazily —
      // and the embedded engines still do, which is why only remote servers ever hit this).
      // Best-effort creation: a db-scoped login carries no DEFINE permission, but then the pair
      // normally already exists and `IF NOT EXISTS` makes these no-ops — so failures are swallowed
      // (`attempt`) and a genuinely missing namespace still surfaces as the `use` error below.
      // `IF NOT EXISTS` is valid on 2.x servers too, so no version branching is needed.
      const namespace = escapeIdent(options.namespace)
      yield* attempt(until(db.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace}`)))
      yield* attempt(
        until(
          db.query(
            `USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${escapeIdent(options.database)}`,
          ),
        ),
      )
      yield* until(db.use({ namespace: options.namespace, database: options.database }))
      sharedDb = db
    }
    const db = sharedDb

    const runRaw = function* (query: Query) {
      const { text, bindings } = toSurreal(query)
      return firstResultSet(yield* until(db.query(text, bindings)))
    }

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
      // the client is shared across pooled connections; only `end()` actually closes it.
      close: operation(function* () {}),
    }
    return connection
  }),
  end: operation(function* () {
    if (sharedDb) {
      yield* until(sharedDb.close())
      sharedDb = null
      // `close()` resolves before the engine's native threads finish tearing down, and a
      // `process.exit` racing that unwind is the residual flaky SIGINT segfault (B1). One
      // macrotask turn while the loop is still alive lets the native side settle first.
      yield* sleep(0)
    }
  }),
})
