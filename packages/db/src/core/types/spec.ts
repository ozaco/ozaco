/**
 * The portable, adapter-facing data shapes: everything that crosses the `DbAdapter` boundary is
 * plain JSON-like data (no DSL machinery, no SQL text), so a spec can be compiled by any backend
 * and can even travel over the wire (a client-supplied filter, a page token, a reconcile plan).
 */
export namespace Spec {
  /** The untyped stored-row shape — validated user columns plus the system fields. */
  export type Doc = Record<string, unknown>

  /** A value a filter can compare against (JSON-serializable apart from `Date`). */
  export type FilterValue = string | number | boolean | null | Date

  /** The storage-level shape of a column. Adapters map each kind to their backend's native type. */
  export type ColumnKind = 'text' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json' | 'enum'

  /** One column as the adapter sees it — pure data, no DSL machinery. */
  export interface Column {
    readonly name: string
    readonly kind: ColumnKind
    readonly optional: boolean
    readonly hasDefault: boolean
    readonly enumValues: readonly string[] | null

    /** true for the implicit `_id`/`_created_at`/`_updated_at`/`_version` columns. */
    readonly system: boolean

    /** true for the primary-key column (`_id`). */
    readonly primary: boolean
  }

  export interface Index {
    readonly name: string
    readonly columns: readonly string[]
    readonly unique: boolean
  }

  /** Everything an adapter needs to know about one table: name + ALL columns (system included) +
   * declared indexes. Core builds this from a `Schema.Table`; adapters stay schema-stateless. */

  export interface Table {
    readonly name: string
    readonly columns: readonly Column[]
    readonly indexes: readonly Index[]
  }

  /**
   * The portable filter algebra. Core compiles query refinements into this; adapters translate it
   * to their native predicate form (SQL `WHERE`, in-memory evaluation, …).
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

        /** `value` everywhere: array ops take an array value (the wire also accepts a legacy
         * `values` key — `sanitizeFilter` normalizes it). */
        readonly value: readonly FilterValue[]
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

  export type FilterOp = Filter['op']

  export interface OrderBy {
    readonly field: string
    readonly direction: 'asc' | 'desc'
  }

  /** A portable read: filter + order + window over one table. */
  export interface Find {
    readonly table: Table
    readonly filter: Filter | null
    readonly order: readonly OrderBy[]
    readonly limit: number | null
    readonly offset: number | null
  }

  export interface Count {
    readonly table: Table
    readonly filter: Filter | null
  }

  /** A portable update: assignments over the matching rows. */
  export interface Update {
    readonly table: Table
    readonly filter: Filter | null
    readonly set: Readonly<Record<string, unknown>>
  }

  export interface Delete {
    readonly table: Table
    readonly filter: Filter | null
  }

  /** One schema-reconcile step, as pure data — each adapter compiles it to its own DDL.
   * `create-table` and `create-index` must be idempotent (`IF NOT EXISTS` semantics). */
  export type Step =
    | { readonly kind: 'create-table'; readonly table: Table }
    | { readonly kind: 'add-column'; readonly table: string; readonly column: Column }
    | { readonly kind: 'drop-column'; readonly table: string; readonly column: string }

    /** the live type of `column` (`from`) is not what its declared kind compiles to; applied
     * with a cast where the backend can (`unsupported: false`), only reported where it can't. */
    | {
        readonly kind: 'alter-column'
        readonly table: string
        readonly column: Column
        readonly from: string
        readonly unsupported: boolean
      }
    | { readonly kind: 'create-index'; readonly table: string; readonly index: Index }
    | { readonly kind: 'drop-index'; readonly table: string; readonly index: string }
    | { readonly kind: 'drop-table'; readonly table: string }
    | { readonly kind: 'reindex'; readonly table: string; readonly indexes: readonly Index[] }

  export type StepKind = Step['kind']

  /** Steps that destroy or rewrite data — skipped by `safe: true` installs / `migrate()` runs. */
  export type DestructiveKind = 'drop-column' | 'drop-table' | 'alter-column'

  export interface Plan {
    readonly steps: readonly Step[]
  }

  export interface PageInfo {
    readonly nextCursor: string | null
    readonly prevCursor: string | null
    readonly hasNext: boolean
    readonly hasPrev: boolean
  }

  /** One page of a keyset-paginated query. */
  export interface Page<TDoc = Doc> {
    readonly data: readonly TDoc[]
    readonly pageInfo: PageInfo

    /** Total rows matching the query (cursor excluded) — present when `count: true` was asked. */
    readonly total?: number | undefined

    /** The table's last applied change token when the page was computed (a `since` seed). */
    readonly token: string
  }

  export interface PaginateOptions {
    readonly cursor?: string | null | undefined
    readonly limit: number
    readonly direction?: 'forward' | 'backward' | undefined

    /** Also compute the total matching-row count (an extra COUNT query). */
    readonly count?: boolean | undefined
  }

  /** The decoded form of an opaque keyset cursor. */
  export interface Cursor {
    readonly column: string
    readonly direction: 'asc' | 'desc'
    readonly value: unknown
    readonly id: string
  }
}
