// oxlint-disable import/exports-last
import { createContext, operation } from 'std:effect'
import { Logger, LogLevel } from 'std:logger'
import { defineProtocol } from 'std:plugin'

import { JsonCodec } from 'std:codec/impl/json'

import { DB_INTERCEPTOR } from '../const'
import type {
  Field,
  Interceptor,
  InterceptorDef,
  Query,
  QueryResult,
  QueryResultRow,
} from '../types'

/**
 * Effect-native ports of Slonik's official interceptors, exposed as framework plugins. Install them
 * BEFORE a pool plugin (`PgPool`/`SqlitePool`/…); each registers its {@link Interceptor} into a shared
 * registry that the pool reads at setup and passes to `createPool`, so the engine runs the hooks in
 * Slonik's order. (The raw {@link Interceptor} objects are still accepted directly by `createPool` for
 * non-plugin use.)
 */

// --- interceptor registry + protocol --------------------------------------------------------------

const InterceptorRegistry = createContext<readonly Interceptor[]>('db:interceptor:registry', [])

const registerInterceptor = operation(function* (interceptor: Interceptor) {
  const current = (yield* InterceptorRegistry.get()) ?? []
  yield* InterceptorRegistry.set([...current, interceptor])
})

/** Read every interceptor registered (by installed interceptor plugins) in the current scope. The
 * pool plugins call this at setup to feed `createPool`. */
export const collectInterceptors = operation(function* () {
  return (yield* InterceptorRegistry.get()) ?? []
})

/** The interceptor protocol. `cloneable` so multiple interceptors can be installed at once; each impl
 * registers itself on setup rather than exposing actions. */
const DbInterceptor = defineProtocol<InterceptorDef.Context, [InterceptorDef.Options?]>({
  name: 'db-interceptor',
  version: '0.0.1',
  subtype: DB_INTERCEPTOR,
  cloneable: true,
})

// --- field name transformation --------------------------------------------------------------------

/** `created_at` → `createdAt`. Leaves names without underscores untouched. */
const snakeToCamel = (value: string): string =>
  value.replaceAll(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase())

export interface FieldNameTransformationOptions {
  /** Only transform fields whose name matches (default: pure `snake_case` — lowercase, digits, `_`). */
  readonly test?: (field: Field) => boolean
}

const makeFieldNameTransformation = (options: FieldNameTransformationOptions): Interceptor => {
  const test = options.test ?? ((field: Field) => /^[a-z0-9_]+$/u.test(field.name))
  return {
    // signature (context, query, row, fields) is fixed by the Interceptor contract
    // oxlint-disable-next-line max-params
    transformRow: operation(function* (
      _context,
      _query,
      row: QueryResultRow,
      fields: readonly Field[],
    ) {
      const rename = new Map<string, string>()
      for (const field of fields) {
        if (test(field)) {
          rename.set(field.name, snakeToCamel(field.name))
        }
      }
      if (rename.size === 0) {
        return row
      }
      const out: QueryResultRow = {}
      for (const key of Object.keys(row)) {
        out[rename.get(key) ?? key] = row[key]!
      }
      return out
    }),
  }
}

/**
 * Rename result-row keys from `snake_case` to `camelCase` — the port of
 * `slonik-interceptor-field-name-transformation`. Only fields passing `test` (default: pure
 * snake_case) are transformed; every other column passes through unchanged.
 */
export const FieldNameTransformation = DbInterceptor.implement({
  name: 'field-name-transformation',
  version: '0.0.1',
  *setup(options: FieldNameTransformationOptions = {}) {
    const interceptor = makeFieldNameTransformation(options)
    yield* registerInterceptor(interceptor)
    return interceptor
  },
}).build({})

// --- shared timing ---------------------------------------------------------------------------------

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

// --- query logging ---------------------------------------------------------------------------------

export interface QueryLoggingOptions {
  /** Include bound parameter values in the log record (default `true`). */
  readonly logValues?: boolean
  /** Level to log successful queries at via the framework logger (default `debug`). Errors always
   * log at `error`. */
  readonly level?: LogLevel
}

const makeQueryLogging = (options: QueryLoggingOptions): Interceptor => {
  const logValues = options.logValues ?? true
  const level = options.level ?? LogLevel.debug
  const started = new Map<string, number>()

  return {
    beforeQueryExecution: operation(function* (context) {
      started.set(context.queryId, now())
      return null
    }),
    afterQueryExecution: operation(function* (context, query, result) {
      const start = started.get(context.queryId)
      started.delete(context.queryId)
      yield* Logger.actions.log(level, 'db query', {
        queryId: context.queryId,
        sql: query.sql,
        ...(logValues ? { values: query.values } : {}),
        rowCount: result.rowCount,
        durationMs: start === undefined ? undefined : now() - start,
      })
    }),
    queryExecutionError: operation(function* (context, query, error) {
      const start = started.get(context.queryId)
      started.delete(context.queryId)
      yield* Logger.actions.error('db query failed', {
        queryId: context.queryId,
        sql: query.sql,
        ...(logValues ? { values: query.values } : {}),
        durationMs: start === undefined ? undefined : now() - start,
        error,
      })
    }),
  }
}

/**
 * Log every query with its timing, row count, and (optionally) bound values through the framework
 * logger (`std:logger`) — the port of `slonik-interceptor-query-logging`. Successful queries log at
 * `level` (default `debug`); execution errors log at `error` with the driver error attached. Requires
 * a logger installed in scope.
 */
export const QueryLogging = DbInterceptor.implement({
  name: 'query-logging',
  version: '0.0.1',
  *setup(options: QueryLoggingOptions = {}) {
    const interceptor = makeQueryLogging(options)
    yield* registerInterceptor(interceptor)
    return interceptor
  },
}).build({})

// --- benchmarking ----------------------------------------------------------------------------------

export interface BenchmarkResult {
  readonly queryId: string
  readonly sql: string
  readonly durationMs: number
}

export interface BenchmarkingOptions {
  /** Called once per successfully-executed query with the elapsed milliseconds. */
  readonly onResult: (result: BenchmarkResult) => void
}

const makeBenchmarking = (options: BenchmarkingOptions): Interceptor => {
  const started = new Map<string, number>()
  return {
    beforeQueryExecution: operation(function* (context) {
      started.set(context.queryId, now())
      return null
    }),
    afterQueryExecution: operation(function* (context, query) {
      const start = started.get(context.queryId)
      started.delete(context.queryId)
      if (start !== undefined) {
        options.onResult({ queryId: context.queryId, sql: query.sql, durationMs: now() - start })
      }
    }),
    queryExecutionError: operation(function* (context) {
      started.delete(context.queryId)
    }),
  }
}

/**
 * Time every query and report the elapsed milliseconds — the port of
 * `slonik-interceptor-query-benchmarking`. A minimal, values-free counterpart to {@link QueryLogging}.
 */
export const Benchmarking = DbInterceptor.implement({
  name: 'benchmarking',
  version: '0.0.1',
  *setup(options: BenchmarkingOptions) {
    const interceptor = makeBenchmarking(options)
    yield* registerInterceptor(interceptor)
    return interceptor
  },
}).build({})

// --- query cache ----------------------------------------------------------------------------------

/** Pluggable cache backend for {@link QueryCache} (swap in Redis, LRU, …). */
export interface QueryCacheStorage {
  get(key: string): QueryResult<QueryResultRow> | null
  set(key: string, value: QueryResult<QueryResultRow>, ttlSeconds: number): void
}

export interface QueryCacheOptions {
  /** Where cached results live (default: an in-memory `Map` honoring each entry's TTL). */
  readonly storage?: QueryCacheStorage
  /** Seconds to cache a query, or `false`/`0` to skip it. Default: honor a `-- @cache-ttl <n>` marker
   * in the SQL, otherwise skip — so caching is opt-in per query. */
  readonly ttl?: (query: Query) => number | false
}

const createMemoryStorage = (): QueryCacheStorage => {
  const store = new Map<string, { value: QueryResult<QueryResultRow>; expiresAt: number }>()
  return {
    get: key => {
      const hit = store.get(key)
      if (!hit) {
        return null
      }
      if (hit.expiresAt <= Date.now()) {
        store.delete(key)
        return null
      }
      return hit.value
    },
    set: (key, value, ttlSeconds) => {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
    },
  }
}

const markerTtl = (query: Query): number | false => {
  const match = /--\s*@cache-ttl\s+(\d+)/u.exec(query.sql)
  return match ? Number(match[1]) : false
}

// key the cache on the SQL + the codec-serialized bound values (JSON via the installed codec — the
// same approach the broker uses for its call cache; no hand-rolled JSON.stringify).
const cacheKeyOf = operation(function* (query: Query) {
  return `${query.sql}::${yield* JsonCodec.actions.stringify(query.values)}`
})

const makeQueryCache = (options: QueryCacheOptions): Interceptor => {
  const storage = options.storage ?? createMemoryStorage()
  const ttlOf = options.ttl ?? markerTtl
  return {
    beforeQueryExecution: operation(function* (_context, query) {
      if (!ttlOf(query)) {
        return null
      }
      return storage.get(yield* cacheKeyOf(query))
    }),
    afterQueryExecution: operation(function* (_context, query, result) {
      const ttl = ttlOf(query)
      if (ttl) {
        storage.set(yield* cacheKeyOf(query), result, ttl)
      }
    }),
  }
}

/**
 * Cache query results with a per-query TTL — the port of `slonik-interceptor-query-cache`. A cache hit
 * short-circuits execution (`beforeQueryExecution` returns the stored {@link QueryResult}); a miss is
 * stored on `afterQueryExecution`. Caching is opt-in: by default only queries carrying a
 * `-- @cache-ttl <seconds>` marker are cached (override with `ttl`).
 *
 * Note: the engine still re-applies `transformRow` to a short-circuited result, so pair this with
 * idempotent row transforms (the shipped {@link FieldNameTransformation} is one).
 */
export const QueryCache = DbInterceptor.implement({
  name: 'query-cache',
  version: '0.0.1',
  *setup(options: QueryCacheOptions = {}) {
    const interceptor = makeQueryCache(options)
    yield* registerInterceptor(interceptor)
    return interceptor
  },
}).build({})
