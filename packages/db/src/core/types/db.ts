import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { AdapterDef, MigrationPlan } from './adapter'
import type { ChangeBus, ChangeEvent, WatchDelta, WatchOptions, WatchSnapshot } from './change'
import type { Filter, Page, PaginateOptions } from './query'
import type { Schema, TableDef } from './schema'

export type TableName<TSchema> = keyof TSchema & string

export type DocOf<TSchema, TName extends TableName<TSchema>> = TSchema[TName] extends {
  doc: infer TDoc
}
  ? TDoc
  : unknown

export type InsertOf<TSchema, TName extends TableName<TSchema>> = TSchema[TName] extends {
  insert: infer TInsert
}
  ? TInsert
  : unknown

/** A lazily-built, immutable query over one table. Chain refiners, then call a terminal — or
 * `watch()` it to get a live-updating snapshot flow. */
export interface QueryHandle<TDoc> {
  where(match: Partial<TDoc>): QueryHandle<TDoc>
  filter(...filters: Filter[]): QueryHandle<TDoc>
  order(field: keyof TDoc & string, direction?: 'asc' | 'desc'): QueryHandle<TDoc>

  collect(): Operation<readonly TDoc[]>
  take(count: number): Operation<readonly TDoc[]>
  first(): Operation<TDoc | null>
  /** Exactly 0 or 1 matching rows; fails `db.data-integrity` when the query matches more. */
  unique(): Operation<TDoc | null>
  count(): Operation<number>
  exists(): Operation<boolean>
  paginate(options: PaginateOptions): Operation<Page<TDoc>>

  /** A never-ending live view of this query: the current result immediately (unless `since` still
   * matches), then again after every relevant committed change (local writes, native live feed,
   * bus, touch). Bursts coalesce into one recompute; changes that provably cannot affect the query
   * (filter mismatch + not in the current result) are skipped without recomputing. `mode: 'delta'`
   * emits {@link WatchDelta}s and suppresses no-op recomputes. Subscription is scope-bound. */
  watch(options: WatchOptions & { mode: 'delta' }): Flow<WatchDelta<TDoc>, never>
  watch(options?: WatchOptions): Flow<WatchSnapshot<TDoc>, never>
}

/** Options for the versioned write methods. */
export interface WriteOptions {
  /** Optimistic concurrency: apply only while the stored `_version` still equals this; fails
   * `db.conflict` when the document exists at a different version. */
  readonly ifVersion?: number | undefined
}

export interface TransactionOptions {
  /** Retries on `db.conflict` (serialization/deadlock/busy) failures. Default 2. */
  readonly retries?: number | undefined
}

/**
 * The typed database handle the `DbClient` install resolves — CRUD + queries + reactivity over the
 * installed adapter. Every write is validated against the table's declared columns (plus its
 * optional Standard Schema validator), stamps `_id`/`_createdAt`/`_version`, and is broadcast to
 * watchers. Effect-native: errors surface as Result failures tagged from `DbErrors`.
 */
export interface Database<TSchema extends Schema = Schema> {
  get<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
  ): Operation<DocOf<TSchema, TName> | null>
  insert<TName extends TableName<TSchema>>(
    table: TName,
    value: InsertOf<TSchema, TName>,
  ): Operation<DocOf<TSchema, TName>>
  /** Validate and insert a batch in ONE adapter round trip (one event per stored row). */
  insertMany<TName extends TableName<TSchema>>(
    table: TName,
    values: readonly InsertOf<TSchema, TName>[],
  ): Operation<readonly DocOf<TSchema, TName>[]>
  patch<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
    value: Partial<InsertOf<TSchema, TName>>,
    options?: WriteOptions,
  ): Operation<DocOf<TSchema, TName> | null>
  replace<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
    value: InsertOf<TSchema, TName>,
    options?: WriteOptions,
  ): Operation<DocOf<TSchema, TName> | null>
  delete<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
    options?: WriteOptions,
  ): Operation<boolean>

  query<TName extends TableName<TSchema>>(table: TName): QueryHandle<DocOf<TSchema, TName>>

  /** Watch one document: its current value immediately, then again after every change to it
   * (`null` once deleted). */
  watch<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
  ): Flow<DocOf<TSchema, TName> | null, never>

  /** The raw change feed, optionally filtered to one table. */
  changes(table?: TableName<TSchema>): Flow<ChangeEvent, never>

  /** Run `body` atomically on the adapter; change events buffer and broadcast only on commit.
   * Retries the whole body on `db.conflict`. Fails `db.unsupported` when the adapter can't. */
  transaction<T>(
    body: (db: Database<TSchema>) => Operation<T>,
    options?: TransactionOptions,
  ): Operation<T>

  /** The current monotonic hub version of a table (`0` before the first observed change). */
  version(table: TableName<TSchema>): number
}

export type DbDef = Plugin<DbDef.Context, [options: DbDef.Options], DbDef.Actions>

export namespace DbDef {
  export interface RawOptions {
    /** Decode result rows by this declared table's column kinds. */
    readonly table?: string | undefined
  }

  export interface Options {
    readonly tables: readonly TableDef[]
    /** `'auto'` (default) reconciles the schema at install; `'manual'` defers to
     * `Db.actions.migrate()`. */
    readonly migrations?: 'auto' | 'manual' | undefined
    /** Skip destructive reconcile steps (drop-column/drop-table). Default false. */
    readonly safe?: boolean | undefined
    /** Cross-node fan-out transport; attachable later via `Db.actions.connectBus`. */
    readonly bus?: ChangeBus | undefined
  }

  export type Context = Database

  export interface Actions {
    /** Run the schema reconcile now (the `migrations: 'manual'` entry point). Respects `safe`. */
    migrate(): Operation<void>
    /** Compute the pending reconcile without applying it. */
    planMigration(): Operation<MigrationPlan>
    /** Dialect-native escape hatch — dispatches to the adapter's `raw` (capability-gated). Params
     * are normalized from app values (`Date`/boolean/json). Pass `options.table` to decode result
     * rows by that table's declared column kinds. Raw WRITES bypass the reactive hub — follow them
     * with {@link touch} so watchers observe the change. */
    raw(
      statement: string,
      params?: readonly unknown[],
      options?: RawOptions,
    ): Operation<AdapterDef.RawResult>
    /** Synthetic invalidation for writes that bypassed the write path (e.g. `raw`): bumps the
     * table's version and fans a `touch` event out to watchers (and the bus). A table-level touch
     * wakes every watcher of the table (doc watchers re-fetch); pass `id` to target one document.
     * Buffered inside transactions like any write; inert when the adapter has a native live feed
     * (the feed already reports external writes). */
    touch(table: string, id?: string): Operation<void>
    /** Whether a cross-node {@link ChangeBus} is attached. */
    hasBus(): Operation<boolean>
    /** Attach a {@link ChangeBus} and start bridging foreign writes into the hub. Idempotent — a
     * no-op returning `false` if one is already attached. */
    connectBus(bus: ChangeBus): Operation<boolean>
    /** Drop a table if it exists. */
    dropTable(table: string): Operation<void>
    /** Drop a declared index (by its declared name) if it exists. */
    dropIndex(table: string, index: string): Operation<void>
    /** Rebuild a table's indexes. */
    reindex(table: string): Operation<void>
  }
}
