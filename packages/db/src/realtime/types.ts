import type { Future, Signal } from 'std:effect'

import type { Filter } from './expr'
import type { Schema } from './schema/types'

/** The stored-row shape at the realtime layer (validated fields + system fields). */
export type Row = Record<string, unknown>

export type ChangeOp = 'insert' | 'patch' | 'replace' | 'delete'

/** A committed write, broadcast on {@link Database.changes} (drives page-aware reactive deltas). */
export interface ChangeEvent {
  readonly table: string
  readonly id: string
  readonly op: ChangeOp
  readonly row?: Row | undefined
  readonly resourceVersion: string
}

/** A {@link ChangeEvent} as it travels across a {@link ChangeBus} — tagged with the id of the node that
 * produced it, so each node can drop the echo of its own writes on receipt. */
export interface BusEvent extends ChangeEvent {
  readonly origin: string
}

/**
 * A cross-process fan-out transport for committed writes. Single-node deployments need none — the
 * in-memory {@link Database.changes} signal already reaches every local watcher. Multi-node ones
 * provide a bus (Redis pub/sub, NATS, Postgres `LISTEN`/`NOTIFY`, …) so a write on ANY node reaches the
 * watchers on EVERY node: the realtime DB `publish`es each local commit, and a background bridge
 * forwards foreign events (`origin !== this node`) into its local `changes` signal, re-running the
 * affected watchers against the shared database.
 *
 * NOTE: per-row `_version` is globally correct (stored in the shared DB, so cross-node delta diffing is
 * exact); the collection-level `resourceVersion` counter remains per-node/best-effort until backed by a
 * shared sequence — see the roadmap.
 */
export interface ChangeBus {
  /** Stable id of THIS node — stamped on published events so echoes are dropped on receipt. */
  readonly origin: string
  /** Broadcast one locally-committed write to the other nodes. */
  publish(event: BusEvent): Future<void>
  /** A never-ending stream of events from all nodes (this node's echoes included). Consume with
   * `yield*` to obtain a subscription, exactly like {@link Database.changes}. */
  readonly events: Signal<BusEvent, never>
}

/** Forward/backward cursor window metadata (spec §0.1). */
export interface PageInfo {
  readonly nextCursor: string | null
  readonly prevCursor: string | null
  readonly hasNext: boolean
  readonly hasPrev: boolean
}

/** One page of a cursor-paginated query (spec §0.1 list envelope). */
export interface Page<TDoc> {
  readonly data: readonly TDoc[]
  readonly pageInfo: PageInfo
  readonly resourceVersion: string
  readonly estimatedCount?: number | undefined
}

export interface PaginateOptions {
  readonly cursor?: string | null | undefined
  readonly limit: number
  readonly direction?: 'forward' | 'backward' | undefined
  readonly estimate?: boolean | undefined
}

/** A lazily-built, immutable query over one table (Convex-style), compiled to the core `sql` tag and
 * run on the installed pool. Chain refiners, then call a terminal. */
export interface QueryHandle<TDoc> {
  where(match: Partial<TDoc>): QueryHandle<TDoc>
  filter(predicate: Filter): QueryHandle<TDoc>
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
