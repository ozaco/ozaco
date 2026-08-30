import type { Operation } from 'std:effect'

import type { Bus } from './bus'
import type { Change } from './change'
import type { Database } from './database'
import type { Schema } from './schema'
import type { Spec } from './spec'

/**
 * Internal helper shapes the core's machinery passes around — never part of a public signature,
 * collected here so no type lives outside `types/`.
 */
export namespace Helpers {
  /** How a hub is wired: the local bus it publishes to, the token minter and the change-log
   * writer (`persist` appends tokened writes to their tables' logs). */

  export interface HubOptions {
    readonly bus: Change.Bus
    readonly mintToken: () => Operation<string>
    readonly persist: (writes: readonly Tokened[], tx: string | null) => Operation<void>

    /** delete ONE just-persisted log row again (a guarded write that missed). */
    readonly retract: (write: Tokened) => Operation<void>

    /** read a table's change log from a `ts` floor (replay / polling). */
    readonly replay: (table: string, fromTs: number) => Operation<readonly Database.LogEntry[]>

    /** the HLC receive rule (`false` = drift-rejected). */
    readonly observe: (token: string) => Operation<boolean>
    readonly replayWindowMs: number
    readonly tables: readonly string[]
  }

  /** A write whose token is settled. */
  export type Tokened = Change.Write & { readonly token: string }

  /** The hub as the core's internals see it: the public {@link Change.Hub} plus the private
   * arrival cursor that watch coalescing needs ("was this queued event already reflected by my
   * last recompute?" cannot be answered by token order — commits and tokens interleave). */

  export interface Hub extends Change.Hub {
    /** count of events applied to a table on THIS node so far (arrival order, never exposed). */
    arrival(table: string): number

    /** Settle a write's token and — outside a transaction — append it to the change log NOW
     * (log-first: a phantom row is harmless, a missing one loses the change). */
    record(write: Change.Write): Operation<Tokened>

    /** Emit a recorded write to watchers + bus (or buffer it inside a transaction). */
    announce(write: Tokened): Operation<void>

    /** Append a transaction's buffered writes to the logs (called right before COMMIT). */
    persist(writes: readonly Tokened[], tx: string): Operation<void>

    /** Take a recorded write's log row back — a guarded write that matched nothing never
     * happened, and its log-first row would otherwise linger as a phantom (spurious
     * `recompute`s, log growth on every denied write). No-op inside a transaction, where
     * `record` never persisted. */
    retract(write: Tokened): Operation<void>

    /** Emit a committed transaction's writes as ONE envelope. */
    flush(writes: readonly Change.Write[], tx: string): Operation<void>

    /** Hub-side counters (merged into `Db.actions.busStats`). */
    stats(): Pick<
      Bus.Stats,
      'received' | 'deduped' | 'gaps' | 'replayed' | 'windowHits' | 'driftRejected' | 'peers'
    >
  }

  /** What the migration planner needs from an install — available before the hub exists. */
  export type Reconciler = Pick<Database.State, 'adapter' | 'specs' | 'logs' | 'safe' | 'info'>

  /** What the change-log routines need from an install. */
  export type Logger = Pick<Database.State, 'adapter' | 'logs' | 'origin' | 'replayWindowMs'>

  /** A declared table resolved for a write: the DSL side (defaults/validator) + the adapter spec. */
  export interface WriteTarget {
    readonly def: Schema.Table
    readonly spec: Spec.Table
  }

  /** What a query handle is bound to: the install state + the table it reads. */
  export interface QueryTarget {
    readonly state: Database.State
    readonly spec: Spec.Table
  }

  /** The system fields every stored document carries — a projection always keeps them. */
  export type SystemField = '_id' | '_created_at' | '_updated_at' | '_version'

  /** The immutable refinement state a query handle carries. */
  export interface QueryState {
    readonly match: Readonly<Record<string, Spec.FilterValue>>
    readonly filters: readonly Spec.Filter[]

    /** sort keys in declaration order; `_id` is appended as the tiebreak when the query runs. */
    readonly order: readonly Spec.OrderBy[]

    /** the projection, or `null` for whole rows. */
    readonly fields: readonly string[] | null

    /** the `groupBy` keys of a grouped terminal. */
    readonly groupBy: readonly string[] | null
  }

  /** Inputs of a single-document watch. */
  export interface DocWatch {
    readonly hub: Hub
    readonly table: string
    readonly id: string
    readonly load: () => Operation<Spec.Doc | null>
  }

  /** Inputs of a query watch. */
  export interface QueryWatch {
    readonly hub: Hub
    readonly table: string

    /** the compiled query predicate (kept for symmetry/diagnostics). */
    readonly filter: Spec.Filter | null

    /** the columns the query's filter and order reference — an update outside the current
     * result that touches none of them cannot affect it (the `fields` skip). */
    readonly fields: ReadonlySet<string>
    readonly load: () => Operation<readonly Spec.Doc[]>

    /** answer a `since` token from the change log (`internal/log.ts`). */
    readonly resolve: (since: string) => Operation<'skip' | 'recompute' | 'snapshot'>
    readonly options?: Change.WatchOptions | undefined
  }

  /** One recompute of a watched query: the fresh rows and the diff against the previous result. */
  export interface WatchComputation {
    readonly rows: readonly Spec.Doc[]
    readonly delta: Change.Delta
  }

  /** The outcome of walking an input object over a table's declared columns. */
  export interface Normalized {
    readonly data: Spec.Doc
    readonly problems: readonly string[]
  }

  /** The `$date` marker a `Date` cursor boundary travels as. */
  export interface WireDate {
    readonly $date: string
  }

  /** The mutable budget/policy of one `sanitizeFilter` walk. */
  export interface SanitizeWalk {
    readonly maxDepth: number
    readonly maxConditions: number
    readonly fields: ReadonlySet<string>
    readonly ops: ReadonlySet<string> | null
    conditions: number
  }
}
