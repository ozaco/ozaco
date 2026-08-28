import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { Spec } from './spec'

/**
 * The `DbAdapter` protocol surface: what a database+driver binding (`db:impl/*`) implements.
 * Specs are portable data; values crossing this boundary are app-level (`Date` for `timestamp`,
 * parsed values for `json`, real booleans) — the adapter owns all storage en/decoding and
 * classifies its backend's native errors into `DbErrors` tags.
 */
export namespace Adapter {
  /** What the installed backend can do beyond the structured data plane. Core checks these before
   * dispatching the capability-gated actions (which also fail cleanly via protocol defaults). */

  export interface Capabilities {
    readonly transactions: boolean

    /** the adapter accepts dialect-native statements via `raw`. */
    readonly raw: boolean

    /** the backend can change a column's type in place (`alter-column`); where it can't, the
     * planner still REPORTS the drift (`unsupported: true`) and `migrate()` leaves it alone. */
    readonly alterColumn: boolean
  }

  /** The adapter protocol context — what an adapter's `setup()` resolves. */
  export interface Options {
    readonly adapter: string
    readonly capabilities: Capabilities
  }

  /** The live storage shape of one table (introspection), or `null` when the table is absent. */
  /** One live column: its backend-native type (lowercase; `null` when the backend does not
   * say) and, for a declared column, the native type its declared kind compiles to on this
   * backend — the planner reports a type drift when the two disagree. */

  export interface ShapeColumn {
    readonly name: string
    readonly type: string | null
    readonly expected: string | null
  }

  export interface Shape {
    readonly columns: readonly ShapeColumn[]
  }

  export interface RawResult {
    readonly rows: readonly Spec.Doc[]
    readonly rowCount: number
  }

  /** The adapter contract. `describe` resolves the impl's {@link Info} (a protocol default —
   * adapters never implement it); `transaction`/`raw` are capability-gated with failing protocol
   * defaults, so an adapter only implements what its backend supports. Reactivity is NOT an
   * adapter concern: every backend is plain write-through storage, the core owns change tracking. */

  export interface Actions {
    /** The installed impl's identity + capabilities. */
    describe(): Operation<Options>
    find(spec: Spec.Find): Operation<readonly Spec.Doc[]>
    count(spec: Spec.Count): Operation<number>

    /** Compute aggregates in the backend — one row per group, each carrying the grouped columns
     * plus every op under its `as` name. */
    aggregate(spec: Spec.Aggregate): Operation<readonly Spec.Doc[]>

    /** Insert fully-stamped rows and return the stored documents (in input order). */
    insert(table: Spec.Table, rows: readonly Spec.Doc[]): Operation<readonly Spec.Doc[]>

    /** Apply assignments and return the updated documents. */
    update(spec: Spec.Update): Operation<readonly Spec.Doc[]>

    /** Delete matching rows and return the removed documents. */
    remove(spec: Spec.Delete): Operation<readonly Spec.Doc[]>
    introspect(table: Spec.Table): Operation<Shape | null>

    /** Every table name the storage currently holds (the planner's view of what exists beyond
     * the declared schema — undeclared tables that carry a change log are leftovers of THIS
     * library and get reconciled; anything else is never touched). */
    tables(): Operation<readonly string[]>
    migrate(steps: readonly Spec.Step[]): Operation<void>

    /** Run `body` atomically. Nested calls become savepoints where the backend supports them. */
    transaction<T>(body: () => Operation<T>): Operation<T>

    /** Dialect-native escape hatch (SQL text for SQL backends). Params are normalized from app
     * values (`Date` → storage timestamp, booleans/objects per dialect); when `table` is given,
     * result rows are decoded by its declared column kinds. */
    raw(statement: string, params?: readonly unknown[], table?: Spec.Table): Operation<RawResult>
  }

  /** The actions every adapter gets for free from {@link Actions} (`adapterDefaults`). */
  export type Defaults = Pick<Actions, 'describe' | 'transaction' | 'raw'>

  /** A built adapter plugin (`MemoryAdapter`, `PgAdapter`, …) — pass one as `Database.Options.adapter`
   * to pin a `DbClient` to it when several adapters share a scope. */
  export type Handle = Plugin<Options, AnyType[], Actions>
}
