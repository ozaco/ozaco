import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { CLEAR } from '../const'

import type { Adapter } from './adapter'
import type { Bus } from './bus'
import type { Change } from './change'
import type { Helpers } from './helpers'
import type { Schema } from './schema'
import type { Spec } from './spec'

/**
 * The app-facing `Db` protocol surface: the typed {@link Database.Handle} (CRUD + queries +
 * reactivity) the `DbClient` install resolves, its query builder, the management-plane actions
 * and the install options.
 */
export namespace Database {
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

  /** What `patch` takes for an insert shape: any subset, and `CLEAR` to null an optional
   * column without fighting the types. The canonical definition — anything wrapping `patch`
   * (e.g. the server's crud ops) types its patch with this. */
  export type Patch<TInsert> = {
    readonly [K in keyof TInsert]?: TInsert[K] | typeof CLEAR
  }

  export type PatchOf<TSchema, TName extends TableName<TSchema>> = Patch<InsertOf<TSchema, TName>>

  /** True for a handle with no declared schema (`Database.Handle` with its default `Schema.Map`):
   * its rows are plain documents, so every field name is allowed. */
  type Untyped<TDoc> = [keyof TDoc & string] extends [never] ? true : false

  /** The field names of a document — what a filter, an order key or a projection may name. */
  export type FieldOf<TDoc> = Untyped<TDoc> extends true ? string : keyof TDoc & string

  /** A numeric column of a document — what `sum`/`avg` may name. */
  export type NumericOf<TDoc> =
    Untyped<TDoc> extends true
      ? string
      : {
          [K in keyof TDoc & string]: TDoc[K] extends number | null | undefined ? K : never
        }[keyof TDoc & string]

  /** The value type behind a field name (an untyped handle answers `unknown`). */
  export type ValueOf<TDoc, TField extends string> = TField extends keyof TDoc
    ? TDoc[TField]
    : unknown

  /** The row shape a projection answers with: the picked columns plus the system fields (an
   * untyped handle keeps its plain-document rows). */
  export type Projected<TDoc, TFields extends string> =
    Untyped<TDoc> extends true
      ? TDoc
      : Pick<TDoc, (TFields | keyof Schema.SystemFields) & keyof TDoc>

  /** What `query.where(...)` accepts: an equality match per column, restricted to the column
   * types a filter can actually compare (`string | number | boolean | Date | null`). A `json`
   * column does not fit an equality match — use `filter(...)` forms deliberately. */
  export type MatchOf<TDoc> =
    Untyped<TDoc> extends true
      ? Readonly<Record<string, Spec.FilterValue>>
      : {
          readonly [
            K in keyof TDoc as TDoc[K] extends Spec.FilterValue | undefined ? K : never
          ]?: TDoc[K] & Spec.FilterValue
        }

  /** A lazily-built, immutable query over one table. Chain refiners, then call a terminal — or
   * `watch()` it to get a live-updating snapshot flow. */

  export interface Query<TDoc> {
    where(match: MatchOf<TDoc>): Query<TDoc>

    /** Refine by the portable filter algebra (`where.eq('done', false)`). The field names are
     * checked against this table's columns: a typo does not compile. */
    filter(...filters: readonly Spec.Filter<FieldOf<TDoc>>[]): Query<TDoc>

    /** Add a sort key. Calls STACK — `order('priority', 'desc').order('title')` sorts by both,
     * in that order, with `_id` as the final tiebreak. */
    order(field: FieldOf<TDoc>, direction?: 'asc' | 'desc'): Query<TDoc>

    /** Read only these columns. The system fields (`_id`, `_version`, timestamps) always come
     * along, so pagination and watching keep working on a projected query. */
    select<const TFields extends readonly FieldOf<TDoc>[]>(
      ...fields: TFields
    ): Query<Projected<TDoc, TFields[number]>>

    collect(): Operation<readonly TDoc[]>
    take(count: number): Operation<readonly TDoc[]>
    first(): Operation<TDoc | null>

    /** Exactly 0 or 1 matching rows; fails `db.data-integrity` when the query matches more. */
    unique(): Operation<TDoc | null>
    count(): Operation<number>
    exists(): Operation<boolean>
    paginate(options: Spec.PaginateOptions): Operation<Spec.Page<TDoc>>

    /** Aggregates over the matching rows — one adapter round trip, nothing pulled into memory.
     * `avg`/`min`/`max` answer `null` when nothing matched. */
    sum(field: NumericOf<TDoc>): Operation<number>
    avg(field: NumericOf<TDoc>): Operation<number | null>
    min<TField extends FieldOf<TDoc>>(field: TField): Operation<ValueOf<TDoc, TField> | null>
    max<TField extends FieldOf<TDoc>>(field: TField): Operation<ValueOf<TDoc, TField> | null>

    /** Group the matching rows by one or more columns; the terminals answer one row per group,
     * carrying the grouped columns plus the aggregate. */
    groupBy<const TFields extends readonly FieldOf<TDoc>[]>(
      ...fields: TFields
    ): Grouped<TDoc, TFields[number]>

    /** A never-ending live view of this query: the current result immediately (unless `since`
     * still matches), then again after every relevant committed change (local writes, bus,
     * touch). Bursts coalesce into one recompute; changes that provably cannot affect the query
     * (deletes of rows outside the result, updates outside it whose `fields` touch neither the
     * filter nor the order) are skipped without recomputing. `mode: 'delta'` emits
     * {@link Change.Delta}s and suppresses no-op recomputes. Subscription is scope-bound. */
    watch(options: Change.WatchOptions & { mode: 'delta' }): Flow<Change.Delta<TDoc>, never>
    watch(options?: Change.WatchOptions): Flow<Change.Snapshot<TDoc>, never>
  }

  /** A grouped query: the same aggregate terminals, answered per group. DELIBERATELY narrow —
   * no paginate/watch/having; a grouped read is a reporting primitive, not a second query
   * language. */
  export interface Grouped<TDoc, TKey extends FieldOf<TDoc>> {
    count(): Operation<readonly (Keys<TDoc, TKey> & { readonly count: number })[]>
    sum(field: NumericOf<TDoc>): Operation<readonly (Keys<TDoc, TKey> & { readonly sum: number })[]>

    avg(
      field: NumericOf<TDoc>,
    ): Operation<readonly (Keys<TDoc, TKey> & { readonly avg: number | null })[]>

    min<TField extends FieldOf<TDoc>>(
      field: TField,
    ): Operation<readonly (Keys<TDoc, TKey> & { readonly min: ValueOf<TDoc, TField> | null })[]>

    max<TField extends FieldOf<TDoc>>(
      field: TField,
    ): Operation<readonly (Keys<TDoc, TKey> & { readonly max: ValueOf<TDoc, TField> | null })[]>
  }

  /** The grouped columns an aggregate answer carries. */
  export type Keys<TDoc, TKey extends string> =
    Untyped<TDoc> extends true ? Spec.Doc : Pick<TDoc, TKey & keyof TDoc>

  /** Options for the reads that address ONE document by id. */
  export interface ReadOptions<TDoc = Spec.Doc> {
    /** A trusted predicate the document must ALSO satisfy (tenancy): a row outside it reads as
     * absent — `null`, never a leak that it exists. Field names are checked against the row. */
    readonly scope?: Spec.Filter<FieldOf<TDoc>> | undefined
  }

  /** Options for the versioned write methods. */
  export interface WriteOptions<TDoc = Spec.Doc> extends ReadOptions<TDoc> {
    /** Optimistic concurrency: apply only while the stored `_version` token still equals this;
     * fails `db.conflict` when the document exists at a different version. */
    readonly ifVersion?: string | undefined
  }

  export interface TransactionOptions {
    /** Retries on `db.conflict` (serialization/deadlock/busy) failures. Default 2. */
    readonly retries?: number | undefined
  }

  /** What a raw statement changed — announced for every row it `RETURNING`s. */
  export interface RawEmit {
    readonly op: Exclude<Change.Op, 'touch'>

    /** the columns the statement changed (names only) — lets query watchers skip. */
    readonly fields?: readonly string[] | undefined

    /** re-version the returned rows (`_version` = the change's token, `_updated_at` = now) with a
     * structured update in the same session/transaction, so delta watchers and `ifVersion` see
     * the change. Default `true` for insert/update, ignored for delete. */
    readonly stamp?: boolean | undefined
  }

  export interface RawOptions {
    /** Decode result rows by this declared table's column kinds (required with `emit`). */
    readonly table?: string | undefined

    /** Announce the statement's effect: every returned row's `_id` becomes a change (log row +
     * watchers + bus). The statement must `RETURNING "_id"` (at least) — a statement that returns
     * nothing fails `db.validation` rather than leaving watchers silently stale. */
    readonly emit?: RawEmit | undefined
  }

  /** What an untrusted (wire-supplied) filter is allowed to reference — see `sanitizeFilter`. */
  export interface FilterPolicy {
    /** Field names the filter may reference. */
    readonly fields: readonly string[]

    /** Allowed operators; defaults to the full algebra. */
    readonly ops?: readonly Spec.FilterOp[] | undefined

    /** Maximum nesting depth of and/or/not. Default 8. */
    readonly maxDepth?: number | undefined

    /** Maximum total number of conditions. Default 32. */
    readonly maxConditions?: number | undefined
  }

  /**
   * The typed database handle — CRUD + queries + reactivity over the installed adapter. Every
   * write is validated against the table's declared columns (plus its optional Standard Schema
   * validator), stamps the system fields, and is broadcast to watchers. Effect-native: errors
   * surface as Result failures tagged from `DbErrors`.
   */

  export interface Handle<TSchema extends Schema.Map = Schema.Map> {
    get<TName extends TableName<TSchema>>(
      table: TName,
      id: string,
      options?: ReadOptions<DocOf<TSchema, TName>>,
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

    /** Insert, or patch the one row already matching `match` — atomically (the whole thing runs
     * in a transaction, so two concurrent upserts cannot both insert). Fails
     * `db.data-integrity` when `match` names more than one row. `value` may omit what `match`
     * already pins (the insert branch writes `{ ...match, ...value }`); any other missing
     * required column fails `db.validation` there. Under a `scope` the lookup is narrowed, the
     * patch branch is guarded, and the insert branch is stamped with the scope's pinned
     * values — a scope that pins no exact values fails `db.validation` on insert. */
    upsert<TName extends TableName<TSchema>>(
      table: TName,
      match: MatchOf<DocOf<TSchema, TName>>,
      value: Partial<InsertOf<TSchema, TName>>,
      options?: WriteOptions<DocOf<TSchema, TName>>,
    ): Operation<DocOf<TSchema, TName>>

    patch<TName extends TableName<TSchema>>(
      table: TName,
      id: string,
      value: PatchOf<TSchema, TName>,
      options?: WriteOptions<DocOf<TSchema, TName>>,
    ): Operation<DocOf<TSchema, TName> | null>

    replace<TName extends TableName<TSchema>>(
      table: TName,
      id: string,
      value: InsertOf<TSchema, TName>,
      options?: WriteOptions<DocOf<TSchema, TName>>,
    ): Operation<DocOf<TSchema, TName> | null>

    delete<TName extends TableName<TSchema>>(
      table: TName,
      id: string,
      options?: WriteOptions<DocOf<TSchema, TName>>,
    ): Operation<boolean>

    query<TName extends TableName<TSchema>>(table: TName): Query<DocOf<TSchema, TName>>

    /** Watch one document: its current value immediately, then again after every change to it
     * (`null` once deleted; a row outside the `scope` reads as absent). */

    watch<TName extends TableName<TSchema>>(
      table: TName,
      id: string,
      options?: ReadOptions<DocOf<TSchema, TName>>,
    ): Flow<DocOf<TSchema, TName> | null, never>

    /** The raw change feed, optionally filtered to one table. */
    changes(table?: TableName<TSchema>): Flow<Change.Event, never>

    /** Run `body` atomically on the adapter; change events buffer and broadcast only on commit.
     * Retries the whole body on `db.conflict`. Fails `db.unsupported` when the adapter can't. */

    transaction<T>(
      body: (db: Handle<TSchema>) => Operation<T>,
      options?: TransactionOptions,
    ): Operation<T>

    /** The token of the last change applied to a table (`VERSION_ZERO` before any) — the
     * `since` seed for a fresh watcher. */
    version(table: TableName<TSchema>): string

    /**
     * A derived handle whose EVERY operation runs under this trusted predicate (tenancy):
     * reads/watches see only matching rows, guarded writes miss (never conflict) outside it,
     * and `insert`/`insertMany`/`upsert` are STAMPED with the scope's pinned values — a scope
     * that pins no exact values (`or`, ranges…) refuses inserts with `db.validation`. Calls
     * chain: `db.scoped(a).scoped(b)` ANDs. `transaction` bodies inherit the scope. The filter
     * spans any table of the schema, so field names are not statically checked here — the
     * per-call `options.scope` forms are, and both compose (AND).
     */
    scoped(scope: Spec.Filter): Handle<TSchema>
  }

  export interface Options {
    /** The ONE schema declaration (`defineSchema({ users, posts })`) — the preferred form. */
    readonly schema?: Schema.Def | undefined

    /** The declared tables — the older form; `schema` supersedes it (exactly one of the two
     * must be given). */
    readonly tables?: readonly Schema.Table[] | undefined

    /** Pin this client to one adapter plugin (`install(DbClient, { adapter: PgAdapter, … })`).
     * Default: the routed `DbAdapter` dispatch — the most recently installed adapter. */
    readonly adapter?: Adapter | undefined

    /** `'auto'` (default) reconciles the schema at install; `'manual'` defers to
     * `Db.actions.migrate()`. */
    readonly migrations?: 'auto' | 'manual' | undefined

    /** Skip destructive reconcile steps (drop-column/drop-table). Default false. */
    readonly safe?: boolean | undefined

    /** This node's identity: the HLC origin of every token it mints and its id on the change
     * bus — exactly 8 Crockford base32 characters (`0-9 A-H J K M N P-T V-Z`). Default: derived
     * from a fresh ULID per install. */
    readonly origin?: string | undefined

    /** Outbox limits (see {@link Bus.OutboxOptions}). */
    readonly bus?: Bus.OutboxOptions | undefined

    /** Poll the change logs every `pollMs` for changes this node has not seen — multi-process
     * reactivity with NO transport at all (a shared sqlite file, …). `0` (default) = off. */
    readonly pollMs?: number | undefined

    /** How far back (ms, by the log's `ts`) a replay or `since` check re-scans the change log to
     * catch commits whose tokens are older than what was already applied (commit order and token
     * order interleave under concurrent transactions). Default 5000. */
    readonly replayWindowMs?: number | undefined

    /** Mint the `_id` of new documents. Default: a 32-char ULID from the installed `std:io` impl
     * (`IO.actions.ulid({ length: 32, window: 100 })` — time-sortable, monotonic), so an IO impl
     * (`BunIO`/`NodeIO`) must be installed before `DbClient` unless this is given. */
    readonly id?: (() => Operation<string>) | undefined
  }

  /** The `Db` protocol context — the typed handle itself (`yield* install(DbClient, …)` and
   * `useDb(...)` both resolve it). */
  export type Context = Handle

  /** The management plane: migrations, imperative DDL, bus wiring, the `raw` escape hatch.
   * DELIBERATELY untyped (`table: string`): operations here address storage, not rows, and are
   * routinely written against tables the calling module never declared. */
  export interface Actions {
    /** Run the schema reconcile now (the `migrations: 'manual'` entry point). Respects `safe`. */
    migrate(): Operation<void>

    /** Compute the pending reconcile without applying it. */
    planMigration(): Operation<Spec.Plan>

    /** Dialect-native escape hatch — dispatches to the adapter's `raw` (capability-gated). Pass
     * `options.table` to decode result rows by that table's declared column kinds, and
     * `options.emit` to announce what the statement changed (otherwise raw WRITES bypass
     * reactivity — follow them with {@link publish} / {@link touch}). */

    raw(
      statement: string,
      params?: readonly unknown[],
      options?: RawOptions,
    ): Operation<Adapter.RawResult>

    /** Synthetic invalidation for writes that bypassed the write path (e.g. `raw`): bumps the
     * table's version and fans a `touch` event out to watchers (and the bus). A table-level touch
     * wakes every watcher of the table; pass `id` to target one document. Buffered inside
     * transactions like any write. */
    touch(table: string, id?: string): Operation<void>

    /** {@link touch} for many documents at once — one event per id, one bus batch. */
    touchBatch(table: string, ids: readonly string[]): Operation<void>

    /** Announce changes made outside the handle (raw statements, foreign writers): every write
     * is validated, minted a token, fed to watchers and shipped over the bus — buffered inside
     * transactions like the handle's own writes. `touch`/`touchBatch` are sugar over this. */
    publish(writes: readonly Change.Write[]): Operation<void>

    /** Mint one fresh change token with this node's origin (e.g. to bind `_version` in a raw
     * statement by hand). */
    version(): Operation<string>

    /** Read a table's change log: the changes after `since` (all when omitted), oldest first. */
    log(table: string, options?: LogOptions): Operation<readonly LogEntry[]>

    /** Row count and the oldest/newest token of a table's change log (`null`s when empty). */
    logStats(table: string): Operation<LogStats>

    /** Delete old change-log rows — by token/time (`before`) or keeping the newest `keep` rows.
     * The newest row of every table is always kept. Without `table` every table is compacted.
     * Returns the number of rows removed. */
    compact(table?: string, options?: CompactOptions): Operation<number>

    /** This node's local {@link Change.Bus} (always present). */
    bus(): Operation<Change.Bus>

    /** Bus/replay counters. */
    busStats(): Operation<Bus.Stats>

    /** Connect the installed `DbBus` (when it is not bridged yet): its incoming events
     * start flowing onto the local bus. Runs once at install; call again after installing a
     * transport later. Returns the number of newly bridged transports. */
    bridge(): Operation<number>

    /** Drop a table if it exists. */
    dropTable(table: string): Operation<void>

    /** Drop a declared index (by its declared name) if it exists. */
    dropIndex(table: string, index: string): Operation<void>

    /** Rebuild a table's indexes. */
    reindex(table: string): Operation<void>
  }

  export interface LogOptions {
    /** Only changes with a token greater than this. */
    readonly since?: string | undefined

    /** Default 500. */
    readonly limit?: number | undefined
  }

  /** One row of a change log (the fixed schema of `__changes_<table>`). */
  export interface LogEntry {
    readonly token: string
    readonly id: string
    readonly op: Change.Op
    readonly fields: readonly string[] | null
    readonly origin: string

    /** group id: the transaction's token, or the change's own token outside one. */
    readonly tx: string

    /** wall-clock ms when the row became visible (≈ commit time). */
    readonly ts: number
  }

  export interface LogStats {
    readonly rows: number
    readonly oldest: string | null
    readonly newest: string | null
  }

  export interface CompactOptions {
    /** Remove rows older than this token, or written before this time. */
    readonly before?: string | Date | undefined

    /** Keep only the newest `keep` rows. */
    readonly keep?: number | undefined
  }

  /** The built `DbClient` plugin type. */
  export type Client = Plugin<Context, [options: Options], Actions>

  /** The install's private state (scope-bound via the `StateRef` context). */
  export interface State {
    /** declared tables by name (the DSL side: defaults + validator). */
    readonly tables: ReadonlyMap<string, Schema.Table>

    /** adapter-facing specs by name (system columns included). */
    readonly specs: ReadonlyMap<string, Spec.Table>

    /** the hidden change-log table of every declared table, by TABLE name. */
    readonly logs: ReadonlyMap<string, Spec.Table>
    readonly replayWindowMs: number
    readonly safe: boolean
    readonly hub: Helpers.Hub

    /** the node's local bus (always present; the `DbBus` plugin hangs off it). */
    readonly bus: Change.Bus

    /** bus contexts already forwarding into `bus.events` (by identity). */
    readonly bridged: Set<Bus.Context>

    /** outbox counters (the hub keeps the receive-side ones). */
    readonly outbox: Pick<Bus.Stats, 'published' | 'failed' | 'coalesced'>

    /** the adapter this install dispatches through — pinned or routed. */
    readonly adapter: Adapter.Actions
    readonly info: Adapter.Options

    /** this node's HLC origin (8 Crockford chars). */
    readonly origin: string
    readonly mintId: () => Operation<string>

    /** mint a change token with this node's origin. */
    readonly mintToken: () => Operation<string>
  }
}
