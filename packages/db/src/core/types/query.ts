import type { TableSpec } from './schema'

/** A value a filter can compare against (JSON-serializable apart from `Date`). */
export type FilterValue = string | number | boolean | null | Date

/**
 * The portable, JSON-shaped filter algebra. Core compiles builder refinements into this; adapters
 * translate it to their native predicate form (SQL `WHERE`, in-memory evaluation, …). Being plain
 * data, filters can travel over the wire (e.g. a client-supplied query) without a translation layer.
 */
export type Filter =
  | {
      readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
      readonly field: string
      readonly value: FilterValue
    }
  | {
      readonly op: 'in' | 'not-in'
      readonly field: string
      readonly values: readonly FilterValue[]
    }
  | {
      readonly op: 'like'
      readonly field: string
      readonly pattern: string
      readonly insensitive?: boolean | undefined
    }
  | { readonly op: 'is-null' | 'not-null'; readonly field: string }
  | { readonly op: 'and' | 'or'; readonly filters: readonly Filter[] }
  | { readonly op: 'not'; readonly filter: Filter }

export interface OrderBy {
  readonly field: string
  readonly direction: 'asc' | 'desc'
}

/** A portable read: filter + order + window over one table. */
export interface FindSpec {
  readonly table: TableSpec
  readonly filter: Filter | null
  readonly order: readonly OrderBy[]
  readonly limit: number | null
  readonly offset: number | null
}

export interface CountSpec {
  readonly table: TableSpec
  readonly filter: Filter | null
}

/** A portable update: assignments plus columns to increment atomically (`_version` bumps). */
export interface UpdateSpec {
  readonly table: TableSpec
  readonly filter: Filter | null
  readonly set: Readonly<Record<string, unknown>>
  readonly bump: readonly string[]
}

export interface DeleteSpec {
  readonly table: TableSpec
  readonly filter: Filter | null
}

// --- pagination -----------------------------------------------------------------------------------

export interface PageInfo {
  readonly nextCursor: string | null
  readonly prevCursor: string | null
  readonly hasNext: boolean
  readonly hasPrev: boolean
}

/** One page of a keyset-paginated query. */
export interface Page<TDoc> {
  readonly data: readonly TDoc[]
  readonly pageInfo: PageInfo
  /** Total rows matching the query (cursor excluded) — present when `count: true` was asked. */
  readonly total?: number | undefined
  /** The table's change-hub version when the page was computed. */
  readonly version: number
}

export interface PaginateOptions {
  readonly cursor?: string | null | undefined
  readonly limit: number
  readonly direction?: 'forward' | 'backward' | undefined
  /** Also compute the total matching-row count (an extra COUNT query). */
  readonly count?: boolean | undefined
}
