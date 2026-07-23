import type { Future, Signal } from 'std:effect'

import type { Row } from './database'

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

/** A mutable slot for the cross-node {@link ChangeBus}, so it can be attached after the database is
 * built (the server wires a Broker-backed bus in once resources mount). */
export interface BusHolder {
  current?: ChangeBus
}
