import type { ObserveDef, OptionsDef, ServerDef } from 'server:core'
import type { Scope, Task } from 'std:effect'

import type { Helpers } from './helpers'

export namespace ObservePluginDef {
  export interface Retention {
    /** how long span rows — and EXCEPTION log records — are kept. Default 7 days. */
    readonly spansMs?: number | undefined

    /** how long every other log record is kept. Default 1 day. */
    readonly logsMs?: number | undefined

    /** how often the pruner deletes expired rows. Default 10 minutes; 0 = never prune. */
    readonly pruneEveryMs?: number | undefined
  }

  export interface Batch {
    /** records per insert batch. Default 200. */
    readonly size?: number | undefined

    /** longest a record waits in memory before its batch is written. Default 50. */
    readonly waitMs?: number | undefined

    /** records held before the oldest are dropped (`stats().dropped`). Default 10 000. */
    readonly maxPending?: number | undefined
  }

  /** One store for the whole cluster: service nodes send their records to a collector node over
   * the carrier, the collector writes them all. Needs a `NetworkCarrier`. */
  export interface Cluster {
    /** Ship this node's records to the cluster's collector instead of writing them here —
     * `'and-local'` sends AND keeps a local copy. Default false. */
    readonly sendToCollector?: boolean | 'and-local' | undefined

    /** While sending and no collector is alive: `'local'` writes the records here after all,
     * `'drop'` discards them. Default `'local'`. */
    readonly whenCollectorDown?: 'local' | 'drop' | undefined

    /** THIS node is the collector: every peer's records land in its store (the gateway, or a
     * dedicated observability node). Default false. */
    readonly isCollector?: boolean | undefined

    /** collector presence beat. Default 5000 (a collector unseen for 3× is down). */
    readonly heartbeatMs?: number | undefined
  }

  export interface Options {
    /** Where the rows go: by default a private `DbClient` over the app's adapter (installed
     * before the server); pass an adapter plugin entry (`SqliteAdapter.use({ path })`) to keep
     * observability in its own database. */
    readonly db?: ServerDef.PluginLike | undefined

    /** Serve the dev console at `/_observe` (needs an edge). Default false. The page is a
     * static shell holding no data — public; everything it shows rides the observe API, which
     * `auth` gates (it asks for a bearer token when the API refuses it). */
    readonly console?: boolean | undefined

    /**
     * Who may read the telemetry — it holds captured bodies and whole failure chains: the `auth`
     * requirement (the action option's shapes) of every observe API action, `/_observe/api/*`
     * (traces, trace, request, stats, cluster, the live feed, the manifest). The same rule as any
     * action's `auth`: the `Auth` plugin must be installed (createServer fails otherwise), and
     * `false` opens the API even under a fail-closed `Auth` default. Default: none of its own —
     * the API falls under `Auth`'s `default` (open without one).
     */
    readonly auth?: OptionsDef.Requirement | undefined

    /**
     * What telemetry may carry beyond the defaults — the SAME switch as `createServer({ observe:
     * { capture } })` (one decision for every sink): a key given here wins over the server
     * option. Default: leave the server's choice.
     */
    readonly capture?: ServerDef.CaptureOptions | undefined

    /**
     * Record the observe service's OWN requests (the console's API calls and its live feed) in
     * full. Default false: like every plugin-owned route, they are recorded only when they fail.
     */
    readonly selfTrace?: boolean | undefined

    /** How long rows are kept. The store has NO content switches: it holds exactly the spans
     * and log records every exporter receives (the kernel decides what is recorded, once). */
    readonly retention?: Retention | undefined
    readonly batch?: Batch | undefined

    /** Cluster mode: send records to a collector node, or be that collector. */
    readonly cluster?: Cluster | undefined
  }

  export interface ResolvedBatch {
    readonly size: number
    readonly waitMs: number
    readonly maxPending: number
  }

  export interface ResolvedRetention {
    readonly spansMs: number
    readonly logsMs: number
    readonly pruneEveryMs: number
  }

  /** The opened store: its private scope (suppressed) and the db handle living in it. */
  export interface OpenStore {
    readonly scope: Scope
    readonly db: Helpers.Db
  }

  /** Called with the ROOT span rows of every written batch (what `watch` streams). */
  export type Watcher = (rows: readonly ObserveDef.SpanRow[]) => void

  export interface State {
    readonly pending: ObserveDef.Event[]
    readonly stats: { recorded: number; dropped: number }
    readonly batch: ResolvedBatch
    readonly retention: ResolvedRetention
    readonly forward: false | 'forward' | 'both'
    readonly fallback: 'local' | 'drop'
    readonly collect: boolean
    readonly collectorHeartbeatMs: number

    /** when a collector last announced itself (forwarders), or never. */
    collectorSeenAt: number

    /** records forwarded / received / written locally as fallback. */
    readonly cluster: { forwarded: number; received: number; fellBack: number }
    readonly watchers: Set<Watcher>
    store: OpenStore | null
    flusher: Task<void> | null
    wake: (() => void) | null
  }
}
