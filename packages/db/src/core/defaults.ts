import type { Operation } from 'std:effect'
import { createContext, ensure, operation, useContext } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { DB_DRIVER, DB_POOL } from './const'
import type { DatabasePool, DriverDef, PoolDef } from './types'
import { collectInterceptors } from './utils/interceptors'
import { createPool } from './utils/pool'

/**
 * The pool plugin. A driver ({@link DbDriver} impl — `PgDriver`/`BunDriver`/`SqliteDriver`/
 * `SurrealDriver`) must be installed first; then `install(Pool, { connectionUri })` builds the
 * {@link DatabasePool} (`createPool` calls the installed driver's `connect`/`end` actions directly).
 * Interceptor plugins registered earlier in scope are merged ahead of `config.interceptors`. Resolve
 * the pool anywhere with `usePool()`.
 */
const PoolProtocol = defineProtocol<PoolDef.Context, [AnyType], PoolDef.Actions>({
  name: 'db-pool',
  version: '0.0.1',
  subtype: DB_POOL,
})

const StateRef = createContext<DatabasePool>('db:pool:state')

/** Resolve the installed {@link DatabasePool} — use it for raw SQL (`(yield* usePool()).one(sql\`…\`)`). */
export const usePool = (): Operation<DatabasePool> => useContext(PoolProtocol.context)

export const Pool = PoolProtocol.implement({
  name: 'pool',
  version: '0.0.1',
  *setup(config: PoolDef.Config) {
    const registered = yield* collectInterceptors()
    const pool = yield* createPool({
      ...config,
      interceptors: [...(config.interceptors ?? []), ...registered],
    })
    yield* StateRef.set(pool)
    // The backend dies WITH ITS SCOPE, not with the process. An embedded engine left open at exit
    // either keeps the loop alive (natural exit never comes) or panics native teardown
    // (@surrealdb/node exits 133/139) — and only a pre-exit close prevents it, deterministically.
    // `end()` is idempotent, so an app that already closes by hand pays nothing.
    yield* ensure(function* () {
      yield* pool.end()
    })
    return pool
  },
}).build({
  close: operation(function* () {
    const pool = yield* useContext(StateRef)
    yield* pool.end()
  }),
})

/**
 * The driver protocol — a backend plugin. Each impl (`PgDriver`/`BunDriver`/`SqliteDriver`/
 * `SurrealDriver`) lives in its own module (`db:impl/{pg,bun,sqlite,surreal}`) and statically imports
 * ONLY its own database package. `setup()` returns {@link DriverDef.Info} (`{ dialect }`); the
 * `connect`/`end` actions hand out physical connections and tear the backend down. `createPool` calls
 * these actions directly, so the pool uses the installed driver with no factory indirection. Not
 * cloneable — one backend per scope.
 */
export const DbDriver = defineProtocol<DriverDef.Info, [DriverDef.Options?], DriverDef.Actions>({
  name: 'db-driver',
  version: '0.0.1',
  subtype: DB_DRIVER,
})

/** Resolve the installed driver's info (`{ dialect }`); install a `*Driver` plugin first. */
export const useDriver = (): Operation<DriverDef.Info> => useContext(DbDriver.context)
