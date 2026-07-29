import type { MongoFilter } from 'db:realtime'
import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

export type MetricsDef = Plugin<
  MetricsDef.Context,
  [options?: MetricsDef.Options],
  MetricsDef.Actions
>

export namespace MetricsDef {
  /** The built-in stores: auto-collected `calls`/`logs`, plus the general-purpose `events` store. */
  export type Table = 'calls' | 'logs' | 'events'

  /** Any table name — the built-in ones (with autocomplete) or one you defined via `define`. */
  export type TableName = Table | (string & {})

  /** A storage-level column type for a user-defined table (`json` → JsonCodec text, not native JSON). */
  export type ColumnType = 'text' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json'

  /** A queried row (column name → value); `meta` arrives as text and is decoded by the query layer. */
  export type Row = Record<string, unknown>

  /** One completed action dispatch. `meta` holds arbitrary custom fields (preserved, not stripped). */
  export interface CallRecord {
    readonly ts: number
    readonly service: string
    readonly action: string
    readonly status: 'success' | 'failure'
    readonly durationMs: number
    readonly error?: string | undefined
    readonly meta?: Record<string, unknown> | undefined
  }

  /** One log line. `meta` carries the log's structured custom fields (bindings + data). */
  export interface LogRecord {
    readonly ts: number
    readonly level: number
    readonly msg: string
    readonly error: string
    readonly meta?: Record<string, unknown> | undefined
  }

  /** A user-recorded custom event/metric: a name, an optional numeric `value`, and custom fields. */
  export interface EventRecord {
    readonly ts: number
    readonly name: string
    readonly value?: number | undefined
    readonly meta?: Record<string, unknown> | undefined
  }

  // The store persists `meta` as JsonCodec text (serialized by the effect layer at flush).
  export interface StoredCall {
    readonly ts: number
    readonly service: string
    readonly action: string
    readonly status: string
    readonly durationMs: number
    readonly error: string | null
    readonly meta: string | null
  }
  export interface StoredLog {
    readonly ts: number
    readonly level: number
    readonly msg: string
    readonly error: string
    readonly meta: string | null
  }
  export interface StoredEvent {
    readonly ts: number
    readonly name: string
    readonly value: number | null
    readonly meta: string | null
  }

  /** The wire batch a `sink: 'forward'` collector ships to the metrics sink service in ONE broker
   * call per flush — rows arrive pre-serialized (`meta` already JsonCodec text). */
  export interface IngestBatch {
    readonly calls: readonly StoredCall[]
    readonly logs: readonly StoredLog[]
    readonly events: readonly StoredEvent[]
  }

  /** The sink service's `query` input — one object, because service actions take a single argument. */
  export interface QuerySpec {
    readonly sql: string
    readonly params?: readonly unknown[] | undefined
  }

  /** MongoDB-style find over a table — the SAME filter language as `@ozaco/db`. */
  export interface FindSpec {
    readonly table: TableName
    readonly filter?: MongoFilter
    readonly sort?: string
    readonly order?: 'asc' | 'desc'
    readonly limit?: number
  }

  /** Bulk export/import of a table to/from a file (DuckDB `COPY`). */
  export interface TransferSpec {
    readonly table: TableName
    readonly path: string
    readonly format?: 'parquet' | 'csv' | 'json'
  }

  /** A manual custom-event insert — the "normal insert" for anything that isn't a call or a log. */
  export interface RecordSpec {
    readonly name: string
    readonly value?: number
    readonly fields?: Record<string, unknown>
  }

  /** Retention: delete a table's rows older than `before` (epoch-ms). */
  export interface PruneSpec {
    readonly table: TableName
    readonly before: number
  }

  /** Define your OWN table with your OWN columns (idempotent `CREATE TABLE IF NOT EXISTS`). */
  export interface DefineSpec {
    readonly table: string
    readonly columns: Record<string, ColumnType>
  }

  /** A plain insert into any table — you control the shape. Object/array values become JsonCodec text. */
  export interface InsertSpec {
    readonly table: string
    readonly row: Record<string, unknown>
  }

  /** The store-level generic insert (values already prepared/serialized by the effect layer). */
  export interface RowInsert {
    readonly table: string
    readonly columns: readonly string[]
    readonly values: readonly unknown[]
  }

  /**
   * A pluggable storage backend — EFFECT-NATIVE: every method is an `operation`/{@link Future} (a driver
   * wraps its native async API with `until` internally, so errors surface as `Result` failures and the
   * work stays cancellation-aware, like the `@ozaco/db` drivers). DuckDB is the default ("main")
   * driver. File `export`/`import` is OPTIONAL — it exists because DuckDB's `COPY` makes it nearly
   * free; a store without a natural bulk-file story simply omits the pair instead of stubbing
   * "unsupported" failures, and the action layer answers for it.
   */
  export interface Store {
    init(): Future<void>
    insertCalls(rows: readonly StoredCall[]): Future<void>
    insertLogs(rows: readonly StoredLog[]): Future<void>
    insertEvents(rows: readonly StoredEvent[]): Future<void>
    /** Create a user-defined table. */
    define(spec: DefineSpec): Future<void>
    /** Insert one prepared row into any table. */
    insertRow(spec: RowInsert): Future<void>
    /** Run a raw read query (`$1..$n` params) — for aggregations (`count`, `avg`, `time_bucket`, …). */
    query(sql: string, params?: readonly unknown[]): Future<Row[]>
    /** Dump a table to a file. Optional — omit it and `Metrics.actions.export` fails as unsupported. */
    export?(spec: TransferSpec): Future<void>
    /** Load a table from a file (appends). Optional, like {@link Store.export}. */
    import?(spec: TransferSpec): Future<void>
    /** Delete rows older than a cutoff; returns the number of rows removed. */
    prune(spec: PruneSpec): Future<number>
    close(): Future<void>
  }

  export interface Options {
    /** Where flushed records go. `'store'` (default) writes the local store. `'forward'` opens NO
     * local store: batches ship to the `metrics-sink` service over the broker (routed locally or via
     * whatever transport is installed), and reads (`find`/`query`/`export`/`prune`/…) delegate the
     * same way — consumers keep calling `Metrics.actions.*` regardless of topology. Exactly one
     * process must register the sink service AND run the collector in `'store'` mode. */
    readonly sink?: 'store' | 'forward'
    /** Provide a custom {@link Store}. Omit to use the built-in DuckDB store at {@link path}. */
    readonly store?: Store
    /** DuckDB connection string for the built-in store: `':memory:'` (default) or a file path. */
    readonly path?: string
    /** Batch-flush buffered records to the store every N ms (default 1000). */
    readonly flushIntervalMs?: number
    /** Auto-instrument every action call into `calls` (installs the metrics policy). Default `true`. */
    readonly calls?: boolean
    /** Capture logs into `logs` (registers a logger transport). Default `true`. */
    readonly logs?: boolean
    /** Attach custom fields to each call record (stored in `calls.meta`). */
    readonly fields?: (event: {
      readonly service: string
      readonly action: string
      readonly status: 'success' | 'failure'
      readonly value?: unknown
    }) => Record<string, unknown> | undefined
  }

  export interface Context {
    /** The local store — `null` when the collector runs in `sink: 'forward'` mode. */
    readonly store: Store | null
  }

  export interface Actions {
    /** Define your OWN table with your OWN columns (idempotent). */
    define(spec: DefineSpec): Future<void>
    /** Plain insert of a row into any table (your table or a built-in one) — you control the shape. */
    insert(spec: InsertSpec): Future<void>
    /** Record a custom event/metric into the `events` store — a typed convenience over `insert`.
     * Buffered + batch-flushed like the rest. */
    record(spec: RecordSpec): Future<void>
    /** MongoDB-style find (same filter language as `@ozaco/db`); custom fields in `meta` are decoded
     * and merged back into each returned row. */
    find(spec: FindSpec): Future<Row[]>
    /** Raw read query — for aggregations DuckDB does well (`count`, `avg`, `time_bucket`, …). Pending
     * buffered records are flushed first. */
    query(sql: string, params?: readonly unknown[]): Future<Row[]>
    /** Export a table to a file (Parquet/CSV/JSON) — flushes first. */
    export(spec: TransferSpec): Future<void>
    /** Import a table from a file (appends). */
    import(spec: TransferSpec): Future<void>
    /** Retention: delete rows older than `before` (epoch-ms); resolves to the number removed. */
    prune(spec: PruneSpec): Future<number>
    /** Force a flush of buffered calls/logs to the store. */
    flush(): Future<void>
  }
}
