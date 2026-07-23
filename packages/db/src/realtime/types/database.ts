import type { DatabasePool } from 'db:core'
import type { Future, Signal } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Schema, SchemaDef, TableDef } from '../schema/types'
import type { Filter } from '../utils/expr'
import type { MongoFilter } from '../utils/filter'

import type { BusHolder, ChangeBus, ChangeEvent } from './change'
import type { Dialect, MigrationMode, MigrationPlan } from './migrate'
import type { Page, PaginateOptions } from './page'

/** The stored-row shape at the realtime layer (validated fields + system fields). */
export type Row = Record<string, unknown>

/** A lazily-built, immutable query over one table (Convex-style), compiled to the core `sql` tag and
 * run on the installed pool. Chain refiners, then call a terminal. */
export interface QueryHandle<TDoc> {
  where(match: Partial<TDoc>): QueryHandle<TDoc>
  filter(predicate: Filter): QueryHandle<TDoc>
  /** Refine by a MongoDB-style filter (`$eq`/`$gt`/`$in`/`$contains`/`$and`/`$or`/… over any field).
   * Compiled against the table's columns; unknown fields are ignored. Composes (AND) with `where`/
   * `filter`/other `match` calls. */
  match(filter: MongoFilter<TDoc>): QueryHandle<TDoc>
  order(field: keyof TDoc & string, direction?: 'asc' | 'desc'): QueryHandle<TDoc>

  collect(): Future<TDoc[]>
  take(count: number): Future<TDoc[]>
  first(): Future<TDoc | null>
  unique(): Future<TDoc | null>
  count(): Future<number>
  paginate(options: PaginateOptions): Future<Page<TDoc>>
}

export type TableName<TSchema> = keyof TSchema & string

export type Doc<TSchema, TName extends TableName<TSchema>> = TSchema[TName] extends {
  doc: infer TDoc
}
  ? TDoc
  : unknown

export type InsertInput<TSchema, TName extends TableName<TSchema>> = TSchema[TName] extends {
  insert: infer TInsert
}
  ? TInsert
  : unknown

/**
 * The Convex-like document handle — CRUD + queries + a reactive write signal, backed by the `@ozaco/db`
 * (Slonik) pool. Every write is validated by the table's zod schema and stamps `_id`/`_createdAt`/
 * `_version`. Effect-native (returns {@link Future}); errors surface as Result failures.
 */
export interface Database<TSchema = Schema> {
  get<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
  ): Future<Doc<TSchema, TName> | null>
  insert<TName extends TableName<TSchema>>(
    table: TName,
    value: InsertInput<TSchema, TName>,
  ): Future<Doc<TSchema, TName>>
  patch<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
    value: Partial<InsertInput<TSchema, TName>>,
  ): Future<Doc<TSchema, TName> | null>
  replace<TName extends TableName<TSchema>>(
    table: TName,
    id: string,
    value: InsertInput<TSchema, TName>,
  ): Future<Doc<TSchema, TName> | null>
  delete<TName extends TableName<TSchema>>(table: TName, id: string): Future<boolean>
  query<TName extends TableName<TSchema>>(table: TName): QueryHandle<Doc<TSchema, TName>>

  /** Emits a {@link ChangeEvent} on every committed write (powers reactive subscriptions). */
  readonly changes: Signal<ChangeEvent, never>

  /** The current monotonic version of a collection (`'0'` before the first write). */
  resourceVersion(table: string): string
}

/** The realtime DB protocol context — the Convex-style {@link Database} an install resolves. */
export type DBContext = Database

export interface DBActions extends Record<string, AnyType> {
  close(): Future<void>
  /** Run the schema reconcile now (the `migrations: 'manual'` entry point). Respects `safe`. */
  migrate(): Future<void>
  /** Compute the pending reconcile without applying it — a manual-migration preview. */
  planMigration(): Future<MigrationPlan>
  /** Whether a cross-node {@link ChangeBus} is already attached. */
  hasBus(): Future<boolean>
  /** Attach a cross-node {@link ChangeBus} and start bridging foreign writes into `changes`. Idempotent
   * — a no-op returning `false` if one is already attached. The server calls this automatically with a
   * Broker-backed bus when resources mount, so multi-node reactivity needs no app wiring. */
  connectBus(bus: ChangeBus): Future<boolean>
  /** Drop a table if it exists. Portable across postgres / sqlite / surreal. */
  dropTable(table: string): Future<void>
  /** Drop a declared index (by its declared name) if it exists. Portable across all dialects. */
  dropIndex(table: string, indexName: string): Future<void>
  /** Rebuild a table's indexes (postgres/sqlite reindex the table; surreal rebuilds each index). */
  reindex(table: string): Future<void>
}

/** Config for {@link RealtimeDb}: the tables to manage and the migration policy. The pool itself is
 * resolved via `usePool()` from an installed driver + `Pool` — install a driver and the pool first
 * (`install(SqliteDriver)` → `install(Pool, …)`), then `RealtimeDb`. */
export interface RealtimeDbConfig {
  readonly tables: readonly TableDef[]
  readonly migrations?: MigrationMode
  readonly safe?: boolean
  /** Cross-node fan-out transport. Omit for a single-node deployment (the default in-memory signal
   * suffices). Supply a {@link ChangeBus} (Redis / NATS / Postgres `LISTEN`-`NOTIFY`) so a write on any
   * node reaches every node's watchers — the plugin bridges foreign events into `changes` at install. */
  readonly bus?: ChangeBus
}

export interface RealtimeState {
  readonly pool: DatabasePool
  readonly schema: SchemaDef
  readonly safe: boolean
  readonly db: Database
  readonly busHolder: BusHolder
  /** The installed driver's dialect, so `migrate()`/`planMigration()` re-run against the right SQL. */
  readonly dialect: Dialect
}
