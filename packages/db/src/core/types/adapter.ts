import type { Flow, Operation } from 'std:effect'

import type { LiveChange } from './change'
import type { Doc } from './common'
import type { CountSpec, DeleteSpec, FindSpec, UpdateSpec } from './query'
import type { ColumnSpec, IndexSpec, TableSpec } from './schema'

/** One schema-reconcile step, as pure data — each adapter compiles it to its own DDL. `create-table`
 * and `create-index` must be idempotent (`IF NOT EXISTS` semantics). */
export type MigrateStep =
  | { readonly kind: 'create-table'; readonly table: TableSpec }
  | { readonly kind: 'add-column'; readonly table: string; readonly column: ColumnSpec }
  | { readonly kind: 'drop-column'; readonly table: string; readonly column: string }
  | { readonly kind: 'create-index'; readonly table: string; readonly index: IndexSpec }
  | { readonly kind: 'drop-index'; readonly table: string; readonly index: string }
  | { readonly kind: 'drop-table'; readonly table: string }
  | { readonly kind: 'reindex'; readonly table: string; readonly indexes: readonly IndexSpec[] }

export interface MigrationPlan {
  readonly steps: readonly MigrateStep[]
}

/** Steps that destroy data — skipped by `safe: true` installs / `migrate()` runs. */
export type DestructiveKind = 'drop-column' | 'drop-table'

export namespace AdapterDef {
  /** What the installed backend can do beyond the structured data plane. Core checks these before
   * dispatching the capability-gated actions (which also fail cleanly via protocol defaults). */
  export interface Capabilities {
    readonly transactions: boolean
    /** the adapter can emit a native change feed (external writes become visible to watchers). */
    readonly live: boolean
    /** the adapter accepts dialect-native statements via `raw`. */
    readonly raw: boolean
  }

  /** The adapter protocol context — what `setup()` resolves. */
  export interface Info {
    readonly adapter: string
    readonly capabilities: Capabilities
  }

  /** The live storage shape of one table (introspection), or `null` when the table is absent. */
  export interface TableShape {
    readonly columns: readonly string[]
  }

  export interface RawResult {
    readonly rows: readonly Doc[]
    readonly rowCount: number
  }

  /**
   * The contract every database+driver binding implements. Specs are portable data; values crossing
   * this boundary are app-level (`Date` for `timestamp`, parsed values for `json`, real booleans) —
   * the adapter owns all storage en/decoding, and classifies its backend's native errors into
   * `DbErrors` tags. `transaction`/`raw`/`live` are capability-gated: the protocol provides failing
   * (resp. `null`) defaults for adapters that omit them.
   */
  export interface Actions {
    find(spec: FindSpec): Operation<readonly Doc[]>
    count(spec: CountSpec): Operation<number>
    /** Insert fully-stamped rows and return the stored documents (in input order). */
    insert(table: TableSpec, rows: readonly Doc[]): Operation<readonly Doc[]>
    /** Apply assignments (+ atomic `bump` increments) and return the updated documents. */
    update(spec: UpdateSpec): Operation<readonly Doc[]>
    /** Delete matching rows and return the removed documents. */
    remove(spec: DeleteSpec): Operation<readonly Doc[]>
    introspect(table: TableSpec): Operation<TableShape | null>
    migrate(steps: readonly MigrateStep[]): Operation<void>
    /** Run `body` atomically. Nested calls become savepoints where the backend supports them. */
    transaction<T>(body: () => Operation<T>): Operation<T>
    /** Open the native change feed for the given tables, or resolve `null` when unsupported. */
    live(tables: readonly TableSpec[]): Operation<Flow<LiveChange, void> | null>
    /** Dialect-native escape hatch (SQL text for SQL backends). Params are normalized from app
     * values (`Date` → storage timestamp, booleans/objects per dialect); when `table` is given,
     * result rows are decoded by its declared column kinds. */
    raw(statement: string, params?: readonly unknown[], table?: TableSpec): Operation<RawResult>
  }
}
