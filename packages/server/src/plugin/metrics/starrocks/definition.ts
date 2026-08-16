import { MetricsStore } from 'server:core'
import type { MetricsStoreDef } from 'server:core'
import { moduleLogger } from 'server:utils'
import { attempt, ensure, operation, until, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { BUILTIN_TABLE_SPECS } from 'server:plugin/metrics'

import { DEFAULT_LABEL_PREFIX, DEFAULT_QUERY_PORT, DEFAULT_USER } from './const'
import { StarRocksErrors } from './errors'
import { compileSelect, defineTableSql, ident, runSql, streamLoad } from './internal'
import type { StarRocks, StarRocksOptions } from './types'

const StarRocksMetricsStoreImpl = MetricsStore.implement<
  StarRocks.Context,
  [options: StarRocksOptions]
>({
  name: 'starrocks-metrics-store',
  version: '0.1.0',

  *setup(options) {
    const log = yield* moduleLogger('server:metrics/starrocks')
    const feUrl = options.feUrl.replace(/\/+$/u, '')

    let feHost: string

    try {
      feHost = new URL(feUrl).hostname
    } catch {
      return yield* fail(
        StarRocksErrors.Configuration,
        `invalid feUrl "${options.feUrl}" — expected e.g. http://127.0.0.1:8030`,
      )
    }

    const queryUrl = options.queryUrl ?? `${feHost}:${DEFAULT_QUERY_PORT}`
    const separator = queryUrl.lastIndexOf(':')
    const host = separator === -1 ? queryUrl : queryUrl.slice(0, separator)
    const port = separator === -1 ? DEFAULT_QUERY_PORT : Number(queryUrl.slice(separator + 1))

    if (!host || !Number.isInteger(port) || port <= 0) {
      return yield* fail(
        StarRocksErrors.Configuration,
        `invalid queryUrl "${queryUrl}" — expected host:port`,
      )
    }

    // Decision (plan §17): queries + raw SQL go over the MySQL protocol — it is StarRocks'
    // canonical query interface (the FE HTTP endpoints are ops-oriented) and was chosen for
    // performance. `mysql2` is an OPTIONAL peer, loaded lazily so ingest-only consumers still
    // pay for it only when installing THIS store.
    const imported = yield* attempt(() => until(import('mysql2/promise')))

    if (isFailure(imported)) {
      return yield* fail(
        StarRocksErrors.Configuration,
        'install mysql2 to query StarRocks (optional peer dependency of @ozaco/server)',
        ...imported.causes,
      )
    }

    const mod = imported.value as AnyType
    const createPool = (mod.createPool ?? mod.default?.createPool) as AnyType

    if (typeof createPool !== 'function') {
      return yield* fail(
        StarRocksErrors.Configuration,
        'the installed mysql2/promise does not expose createPool',
      )
    }

    const user = options.user ?? DEFAULT_USER
    const password = options.password ?? ''
    const pool = createPool({
      host,
      port,
      user,
      password,
      connectionLimit: 4,
      supportBigNumbers: true,
    }) as StarRocks.PoolLike

    // scope teardown releases the pool even when `close()` was never called (double-end is
    // swallowed — `close()` remains the explicit path)
    yield* ensure(function* () {
      yield* attempt(() => until(pool.end()))
    })

    return {
      feUrl,
      database: options.database,
      credentials: Buffer.from(`${user}:${password}`).toString('base64'),
      labelPrefix: options.labelPrefix ?? DEFAULT_LABEL_PREFIX,
      beUrl: options.beUrl,
      pool,
      log,
    }
  },
})

const useStore = () => useContext(StarRocksMetricsStoreImpl.context)

/**
 * The StarRocks `MetricsStore`. Ingest goes over Stream Load (FE HTTP via the std `Fetch` plugin —
 * `install(FetchClient)` and a JSON codec are the consumer's job); queries, DDL and pruning go
 * over the MySQL protocol via the optional `mysql2` peer.
 */
export const StarRocksMetricsStore = StarRocksMetricsStoreImpl.build({
  init: operation(function* () {
    const ctx = yield* useStore()

    yield* runSql(ctx, `CREATE DATABASE IF NOT EXISTS ${yield* ident(ctx.database)}`)

    for (const spec of BUILTIN_TABLE_SPECS) {
      yield* runSql(ctx, yield* defineTableSql(ctx.database, spec))
    }

    yield* ctx.log.debug('starrocks store ready', { database: ctx.database })
  }),

  insert: operation(function* (table: string, rows: readonly MetricsStoreDef.Row[]) {
    if (rows.length === 0) {
      return
    }

    const ctx = yield* useStore()

    yield* streamLoad(ctx, table, rows)
  }),

  query: operation(function* (spec: MetricsStoreDef.QuerySpec) {
    const ctx = yield* useStore()
    const compiled = yield* compileSelect(ctx.database, spec)

    return yield* runSql(ctx, compiled.sql, compiled.params)
  }),

  sql: operation(function* (statement: string, params?: readonly unknown[]) {
    const ctx = yield* useStore()

    return yield* runSql(ctx, statement, params)
  }),

  define: operation(function* (spec: MetricsStoreDef.DefineSpec) {
    const ctx = yield* useStore()

    yield* runSql(ctx, yield* defineTableSql(ctx.database, spec))
  }),

  prune: operation(function* (spec: MetricsStoreDef.PruneSpec) {
    const ctx = yield* useStore()
    const table = `${yield* ident(ctx.database)}.${yield* ident(spec.table)}`
    const cutoff = Date.now() - spec.olderThanMs

    // StarRocks DELETE reports no affected-row count over the wire — count first (best effort,
    // racy only against concurrent inserts of already-expired rows)
    const counted = yield* runSql(ctx, `SELECT COUNT(*) AS n FROM ${table} WHERE \`ts\` < ?`, [
      cutoff,
    ])
    const count = Number(counted[0]?.n ?? 0)

    if (count > 0) {
      yield* runSql(ctx, `DELETE FROM ${table} WHERE \`ts\` < ?`, [cutoff])
    }

    return count
  }),

  close: operation(function* () {
    const ctx = yield* useStore()

    yield* attempt(() => until(ctx.pool.end()))
  }),
})
