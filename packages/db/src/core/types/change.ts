import type { Flow, Operation } from 'std:effect'
import type { EventEmitter } from 'std:event'

import type { Bus as BusDef } from './bus'
import type { Spec } from './spec'

/**
 * The reactive plane: how committed writes travel from their source (a local write, the bus, a
 * replay from the change log) through the per-install change hub to watchers. Events never carry
 * documents — a watcher that needs the data re-reads it; what travels is identity + a token.
 */
export namespace Change {
  /** `touch` is a synthetic invalidation (`Db.actions.touch`, heal) — "re-read this". */
  export type Op = 'insert' | 'update' | 'delete' | 'touch'

  /** Where a change entered this node's hub. */
  export type Source = 'local' | 'bus' | 'replay'

  /**
   * One change as every source reports it. `fields` is the list of changed column NAMES — only
   * on `update`, never values — and is a promise the announcer makes: query watchers use it to
   * skip updates that cannot affect them. Omit it when unknown (no skipping then).
   */

  export interface Write {
    readonly table: string

    /** Empty string on a table-level `touch` (no specific document). */
    readonly id: string
    readonly op: Op
    readonly fields?: readonly string[] | undefined

    /** The change's token when the announcer already minted it — the handle reuses the row's
     * new `_version` so one write is ONE token (row and event agree); `Db.actions.version()` +
     * raw statements can do the same. Omitted → the hub mints one. */
    readonly token?: string | undefined
  }

  /** A committed change with its HLC token, as fanned out to watchers. */
  export interface Event extends Write {
    /** The change's HLC token (time-sortable, decodable via `IO.actions.decodeHlc`). */
    readonly token: string
    readonly source: Source
  }

  /** A change as it travels between nodes. */
  export interface BusEvent extends Write {
    readonly token: string
  }

  /** The event map of the hub's own emitter (what `changes()` subscribes to). */
  export type HubEvents = {
    change: [event: Event]
  }

  /**
   * The node's local change bus — always present. Every committed local write is `publish`ed
   * on it (one transaction flush = one batch); `events` is the single fan-in point foreign
   * changes enter the hub through. Cross-node delivery is the `DbBus` plugin's job.
   */

  export interface Bus {
    /** Stable id of THIS node (8 Crockford chars) — the HLC origin of every token it mints. */
    readonly origin: string

    /** Queue one envelope of locally-committed writes for the peers (the outbox ships it). */
    publish(envelope: BusDef.Envelope): Operation<void>

    /** Foreign envelopes arrive here (own echoes included — dropped by origin). */
    readonly events: EventEmitter<BusDef.Events>
  }

  /**
   * The per-install change hub — the single fan-out point reactivity is built on. Sources feed
   * it from three sides (local writes, the bus, replays); watchers consume it via `changes()`.
   * Inside a transaction `publish` buffers and the events reach watchers (and the bus) only on
   * commit (`flush`).
   */

  export interface Hub {
    /** Announce one committed local write (mints its token) — or buffer it inside a transaction. */
    publish(write: Write): Operation<void>

    /** Run `body` with a fresh transaction buffer capturing every `publish`. */
    isolate<T>(buffer: Write[], body: () => Operation<T>): Operation<T>

    /** Feed one foreign envelope: dedupe by `(origin, seq)`, replay the change log on a gap or a
     * new peer, apply the events. */
    feedBus(envelope: BusDef.Envelope): Operation<void>

    /** Apply whatever the change logs hold that this node has not seen (polling / heal). */
    sync(tables?: readonly string[]): Operation<void>

    /** The change feed, optionally filtered to one table. Subscription binds to the consuming
     * scope. */
    changes(table?: string): Flow<Event, never>

    /** The token of the last change applied to a table (`VERSION_ZERO` before any). */
    version(table: string): string
  }

  /** One emission of a watched query in snapshot mode: fresh rows + the token they reflect. */
  export interface Snapshot<TDoc = Spec.Doc> {
    readonly rows: readonly TDoc[]
    readonly token: string

    /** stamped on the initial (primed) emission only — never on live recomputes. */
    readonly baseline?: true
  }

  /** One emission of a watched query in delta mode: what changed since the previous emission
   * (`removed` carries ids). The initial baseline emission lists every row as `added` and is
   * stamped `baseline: true` — a `since` resume that is provably current skips it entirely, so
   * its consumer's FIRST emission may be a live diff. */

  export interface Delta<TDoc = Spec.Doc> {
    readonly added: readonly TDoc[]
    readonly changed: readonly TDoc[]
    readonly removed: readonly string[]
    readonly token: string

    /** stamped on the initial (primed) emission only — never on live diffs. */
    readonly baseline?: true
  }

  /** Options for `query().watch()`. */
  export interface WatchOptions {
    /** `'snapshot'` (default) re-emits the full result; `'delta'` emits added/changed/removed and
     * suppresses no-op recomputes entirely. */
    readonly mode?: 'snapshot' | 'delta' | undefined

    /** The token the consumer already reflects (from a previous emission / `db.version`). When
     * nothing changed since, the initial emission is skipped — the resume path for reconnecting
     * subscribers, valid on ANY node. */
    readonly since?: string | undefined
  }
}
