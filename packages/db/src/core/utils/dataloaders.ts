// oxlint-disable import/exports-last
import type { Future } from 'std:effect'
import { operation } from 'std:effect'

import { JsonCodec } from 'std:codec/impl/json'
import type { ZodType } from 'zod'

import type {
  CommonQueryMethods,
  FragmentSqlToken,
  PrimitiveValueExpression,
  QueryResultRow,
  QuerySqlToken,
} from '../types'

import { sql } from './sql'

/**
 * Effect-native ports of `@slonik/dataloaders`. The auto-batching of the upstream (Facebook)
 * DataLoader relies on the promise microtask queue, which the effect runtime does not expose; the
 * batch primitive here is the explicit {@link NodeByIdLoader.loadMany} (one round-trip for many ids),
 * with `load` reading through a per-loader cache. All loaders run against any {@link CommonQueryMethods}
 * surface — a pool, a checked-out connection, or a transaction.
 *
 * Note: loaders read raw column names (`row[column]`), so pair them with a pool that does NOT have the
 * field-name-transformation interceptor installed, or set the config columns to the transformed names.
 */

const cacheKey: (value: PrimitiveValueExpression) => string = String

// --- node by id -----------------------------------------------------------------------------------

export interface NodeByIdLoaderConfig<Row extends QueryResultRow> {
  /** The table (single identifier) to load rows from. */
  readonly table: string
  /** The key column, matched with `IN (...)` (default `id`). */
  readonly column?: string
  /** Optional zod parser; each loaded row is validated (fails `DbError.DataIntegrity` on mismatch). */
  readonly parser?: ZodType<Row>
}

/** A cached batch loader keyed by a single column — the port of `createNodeByIdLoaderClass`. */
export interface NodeByIdLoader<Row extends QueryResultRow> {
  /** Resolve one row by key (cache-first), or `null` when absent. */
  load(id: PrimitiveValueExpression): Future<Row | null>
  /** Resolve many keys in ONE query, returning results positionally (`null` for misses). */
  loadMany(ids: readonly PrimitiveValueExpression[]): Future<ReadonlyArray<Row | null>>
  /** Seed the cache so a subsequent `load` skips the round-trip. */
  prime(id: PrimitiveValueExpression, row: Row): void
  /** Forget one cached key. */
  clear(id: PrimitiveValueExpression): void
  /** Forget every cached key. */
  clearAll(): void
}

export const createNodeByIdLoader = <Row extends QueryResultRow>(
  pool: Pick<CommonQueryMethods, 'any'>,
  config: NodeByIdLoaderConfig<Row>,
): NodeByIdLoader<Row> => {
  const column = config.column ?? 'id'
  const table = sql.identifier([config.table])
  const key = sql.identifier([column])
  const cache = new Map<string, Row | null>()

  const query = (ids: readonly PrimitiveValueExpression[]): QuerySqlToken<Row> => {
    const list = sql.join([...ids], sql.fragment`, `)
    return config.parser
      ? sql.type(config.parser)`SELECT * FROM ${table} WHERE ${key} IN (${list})`
      : (sql`SELECT * FROM ${table} WHERE ${key} IN (${list})` as QuerySqlToken<Row>)
  }

  const loadMany = operation(function* (ids: readonly PrimitiveValueExpression[]) {
    const missing = new Map<string, PrimitiveValueExpression>()
    for (const id of ids) {
      const k = cacheKey(id)
      if (!cache.has(k)) {
        missing.set(k, id)
      }
    }
    if (missing.size > 0) {
      const rows = yield* pool.any(query([...missing.values()]))
      for (const k of missing.keys()) {
        cache.set(k, null)
      }
      for (const row of rows) {
        cache.set(cacheKey(row[column] as PrimitiveValueExpression), row)
      }
    }
    return ids.map(id => cache.get(cacheKey(id)) ?? null)
  })

  const load = operation(function* (id: PrimitiveValueExpression) {
    const k = cacheKey(id)
    if (cache.has(k)) {
      return cache.get(k) ?? null
    }
    const rows = yield* loadMany([id])
    return rows[0] ?? null
  })

  return {
    load,
    loadMany,
    prime: (id, row) => {
      const k = cacheKey(id)
      if (!cache.has(k)) {
        cache.set(k, row)
      }
    },
    clear: id => {
      cache.delete(cacheKey(id))
    },
    clearAll: () => {
      cache.clear()
    },
  }
}

// --- relay connection -----------------------------------------------------------------------------

export interface ConnectionOrderBy {
  readonly column: string
  readonly direction?: 'ASC' | 'DESC'
}

/** Relay connection arguments — forward (`first`/`after`) or backward (`last`/`before`). */
export interface ConnectionArgs {
  readonly first?: number | undefined
  readonly after?: string | undefined
  readonly last?: number | undefined
  readonly before?: string | undefined
  /** Extra predicate ANDed into the query, e.g. `sql.fragment\`status = ${'active'}\``. */
  readonly where?: FragmentSqlToken | undefined
  /** Single keyset column (+ id tiebreaker). Defaults to the id column, ascending. */
  readonly orderBy?: ConnectionOrderBy | undefined
}

export interface ConnectionEdge<Row extends QueryResultRow> {
  readonly node: Row
  readonly cursor: string
}

export interface ConnectionPageInfo {
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
  readonly startCursor: string | null
  readonly endCursor: string | null
}

export interface Connection<Row extends QueryResultRow> {
  readonly edges: ReadonlyArray<ConnectionEdge<Row>>
  readonly pageInfo: ConnectionPageInfo
  /** Total rows matching `where`, ignoring pagination. */
  readonly count: number
}

export interface ConnectionLoaderConfig<Row extends QueryResultRow> {
  readonly table: string
  /** The keyset tiebreaker + cursor identity column (default `id`). */
  readonly idColumn?: string
  readonly parser?: ZodType<Row>
}

const DEFAULT_PAGE_SIZE = 50

// cursors are the codec-serialized `[orderValue, id]` pair, base64url-wrapped to stay opaque/url-safe
// (serialization goes through the installed codec — no hand-rolled JSON).
const encodeCursor = operation(function* (orderValue: unknown, idValue: unknown) {
  const text = yield* JsonCodec.actions.stringify([orderValue, idValue])
  return Buffer.from(text).toString('base64url')
})

const decodeCursor = operation(function* (raw: string) {
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  return (yield* JsonCodec.actions.parse(text)) as readonly [
    PrimitiveValueExpression,
    PrimitiveValueExpression,
  ]
})

/**
 * A Relay-style cursor connection over a table — the port of `createConnectionLoaderClass`. Uses
 * keyset pagination (row-value comparison on `[orderBy, id]`), fetching `limit + 1` to derive
 * `hasNextPage`/`hasPreviousPage`, and a separate `COUNT(*)` for the total.
 */
export const createConnectionLoader = <Row extends QueryResultRow>(
  pool: Pick<CommonQueryMethods, 'any' | 'oneFirst'>,
  config: ConnectionLoaderConfig<Row>,
) => {
  const idColumn = config.idColumn ?? 'id'
  const table = sql.identifier([config.table])
  const idc = sql.identifier([idColumn])

  const load = operation(function* (args: ConnectionArgs = {}) {
    const orderBy = args.orderBy ?? { column: idColumn, direction: 'ASC' as const }
    const declaredAsc = (orderBy.direction ?? 'ASC') === 'ASC'
    const oc = sql.identifier([orderBy.column])
    const where = args.where ?? sql.fragment`TRUE`

    const count = Number(
      yield* pool.oneFirst(sql`SELECT COUNT(*) AS "count" FROM ${table} WHERE ${where}`),
    )

    const backward = args.last !== undefined || args.before !== undefined
    const limit = backward ? (args.last ?? DEFAULT_PAGE_SIZE) : (args.first ?? DEFAULT_PAGE_SIZE)
    const cursor = backward ? args.before : args.after

    // Backward pages walk the ordering in reverse, then flip the result back to declared order.
    const fetchAsc = backward ? !declaredAsc : declaredAsc
    const dir = fetchAsc ? sql.fragment`ASC` : sql.fragment`DESC`

    let keyset: FragmentSqlToken = sql.fragment`TRUE`
    if (cursor !== undefined) {
      const [ov, idv] = yield* decodeCursor(cursor)
      keyset = fetchAsc
        ? sql.fragment`(${oc}, ${idc}) > (${ov}, ${idv})`
        : sql.fragment`(${oc}, ${idc}) < (${ov}, ${idv})`
    }

    const body = sql.fragment`
      FROM ${table}
      WHERE ${where} AND ${keyset}
      ORDER BY ${oc} ${dir}, ${idc} ${dir}
      LIMIT ${limit + 1}
    `
    const token: QuerySqlToken<Row> = config.parser
      ? sql.type(config.parser)`SELECT * ${body}`
      : (sql`SELECT * ${body}` as QuerySqlToken<Row>)

    const fetched = yield* pool.any(token)
    const hasMore = fetched.length > limit
    const trimmed = hasMore ? fetched.slice(0, limit) : [...fetched]
    const rows = backward ? [...trimmed].toReversed() : trimmed

    const edges: ConnectionEdge<Row>[] = []
    for (const row of rows) {
      edges.push({ node: row, cursor: yield* encodeCursor(row[orderBy.column], row[idColumn]) })
    }

    return {
      edges,
      count,
      pageInfo: {
        hasNextPage: backward ? cursor !== undefined : hasMore,
        hasPreviousPage: backward ? hasMore : cursor !== undefined,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges.at(-1)?.cursor ?? null,
      },
    } satisfies Connection<Row>
  })

  return { load }
}
