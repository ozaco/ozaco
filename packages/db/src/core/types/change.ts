import type { Flow, Operation } from 'std:effect'

import type { Doc } from './common'

/** `touch` is a synthetic invalidation (`Db.actions.touch`, live-feed catch-up) — "this table/doc
 * changed outside the write path, re-read it"; it carries no document. */
export type ChangeOp = 'insert' | 'update' | 'delete' | 'touch'

/** Where a change entered this node's hub: a local write, the adapter's native live feed, or a
 * cross-node bus. */
export type ChangeSource = 'local' | 'live' | 'bus'

/** A committed write, fanned out to every watcher (powers `changes()`/`watch()`). */
export interface ChangeEvent {
  readonly table: string
  /** Empty string on a table-level `touch` (no specific document). */
  readonly id: string
  readonly op: ChangeOp
  /** The stored document after the write. `null` on deletes, touches and bus-sourced events —
   * consumers re-read from the database (the single source of truth). */
  readonly doc: Doc | null
  /** The table's monotonic hub version after this change (node-local). */
  readonly version: number
  /** Optional backend-global cursor (e.g. the Postgres transaction id from the live feed) for
   * cross-node resume protocols. Node-local sources leave it undefined. */
  readonly cursor?: number | undefined
  readonly source: ChangeSource
}

/** A change as reported by an adapter's native live feed (the hub assigns version/source). */
export interface LiveChange {
  readonly table: string
  readonly id: string
  readonly op: ChangeOp
  readonly doc: Doc | null
  /** Backend-global cursor for this change, when the backend can provide one. */
  readonly cursor?: number | undefined
}

/**
 * A change as it travels across a {@link ChangeBus} — an INVALIDATION, not a data carrier: it
 * names what changed (`table`/`id`/`op`) but never the document. Receiving nodes re-read from the
 * shared database, so a lost or reordered bus message can only delay a wake-up, never serve stale
 * data. Tagged with the id of the node that produced it, so echoes are dropped on receipt.
 */
export interface BusEvent {
  readonly table: string
  readonly id: string
  readonly op: ChangeOp
  readonly version: number
  readonly cursor?: number | undefined
  readonly origin: string
}

/**
 * A cross-process fan-out transport for committed writes. Single-node deployments need none — the
 * in-process hub already reaches every local watcher. Adapters with a native live feed (e.g. pg
 * LISTEN/NOTIFY) make a bus redundant too: every node hears the backend directly, so a bus is only
 * needed for multi-node deployments on write-through adapters. Provide one (Redis pub/sub, NATS,
 * …) so a write on ANY node wakes the watchers on EVERY node.
 */
export interface ChangeBus {
  /** Stable id of THIS node — stamped on published events so echoes are dropped on receipt. */
  readonly origin: string
  /** Broadcast a batch of locally-committed writes (one transaction flush = one call). */
  publish(events: readonly BusEvent[]): Operation<void>
  /** A never-ending flow of events from all nodes (this node's echoes included). */
  readonly events: Flow<BusEvent, never>
}

/** One emission of a watched query in snapshot mode: fresh rows + the table version. */
export interface WatchSnapshot<TDoc = Doc> {
  readonly rows: readonly TDoc[]
  readonly version: number
}

/** One emission of a watched query in delta mode: what changed since the previous emission
 * (`removed` carries ids). The first emission lists every row as `added`. */
export interface WatchDelta<TDoc = Doc> {
  readonly added: readonly TDoc[]
  readonly changed: readonly TDoc[]
  readonly removed: readonly string[]
  readonly version: number
}

/** Options for `query().watch()`. */
export interface WatchOptions {
  /** `'snapshot'` (default) re-emits the full result; `'delta'` emits added/changed/removed and
   * suppresses no-op recomputes entirely. */
  readonly mode?: 'snapshot' | 'delta' | undefined
  /** The table version the consumer already reflects (from a previous emission / `db.version`).
   * When it still matches, the initial emission is skipped — the resume path for reconnecting
   * subscribers. Node-local, like `version` itself. */
  readonly since?: number | undefined
}
