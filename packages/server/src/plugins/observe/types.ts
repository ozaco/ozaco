import type { Database, Schema, Spec } from 'db:core'
import type { ObserveDef, ServerDef } from 'server:core'
import type { Queue, Task } from 'std:effect'
import type { AnyType } from 'std:shared'

export namespace ObservePluginDef {
  export interface Retention {
    /** how long request, span and failure rows are kept. Default 7 days. */
    readonly requestsMs?: number | undefined

    /** how long log and event rows are kept. Default 1 day. */
    readonly logsMs?: number | undefined

    /** how often the pruner deletes expired rows. Default 10 minutes; 0 = never prune. */
    readonly pruneEveryMs?: number | undefined
  }

  export interface Batch {
    /** rows per insert batch. Default 200. */
    readonly size?: number | undefined

    /** longest a row waits in memory before its batch is written. Default 50. */
    readonly waitMs?: number | undefined

    /** rows held before the oldest are dropped (`stats().dropped`). Default 10 000. */
    readonly maxPending?: number | undefined
  }

  /** Which kinds this node RECORDS — a kind set to `false` is skipped before it ever queues,
   * so it reaches neither this store nor the cluster's collector. Exporters observe through
   * their own hooks and still see everything. Default: every kind. */
  export interface Store {
    readonly requests?: boolean | undefined
    readonly spans?: boolean | undefined
    readonly logs?: boolean | undefined
    readonly failures?: boolean | undefined
    readonly events?: boolean | undefined
  }

  /** One store for the whole cluster: service nodes send their rows to a collector node over
   * the carrier, the collector writes them all. Needs a `NetworkCarrier`. */
  export interface Cluster {
    /** Ship this node's rows to the cluster's collector instead of writing them here —
     * `'and-local'` sends AND keeps a local copy. Default false. */
    readonly sendToCollector?: boolean | 'and-local' | undefined

    /** While sending and no collector is alive: `'local'` writes the rows here after all,
     * `'drop'` discards them. Default `'local'`. */
    readonly whenCollectorDown?: 'local' | 'drop' | undefined

    /** THIS node is the collector: every peer's rows land in its store (the gateway, or a
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

    /** Serve the dev console at `/_observe` (needs an edge). Default false. */
    readonly console?: boolean | undefined

    /** Print every request/failure/log line to stdout as it happens (dev). Default false. */
    readonly stdout?: boolean | undefined

    /** Which kinds this node records. Default: all of them. */
    readonly store?: Store | undefined
    readonly retention?: Retention | undefined
    readonly batch?: Batch | undefined

    /** Cluster mode: send rows to a collector node, or be that collector. */
    readonly cluster?: Cluster | undefined
  }

  /** A unit of work for the store scope (the private db lives in its own scope). */
  export interface Job {
    readonly body: (db: Database.Handle<AnyType>) => AnyType
    readonly resolve: (value: unknown) => void
    readonly reject: (error: unknown) => void
  }

  export interface ResolvedBatch {
    readonly size: number
    readonly waitMs: number
    readonly maxPending: number
  }

  export interface ResolvedRetention {
    readonly requestsMs: number
    readonly logsMs: number
    readonly pruneEveryMs: number
  }

  export interface ResolvedStore {
    readonly requests: boolean
    readonly spans: boolean
    readonly logs: boolean
    readonly failures: boolean
    readonly events: boolean
  }

  export interface State {
    readonly jobs: Queue<Job, void>
    readonly pending: ObserveDef.Event[]
    readonly stats: { recorded: number; dropped: number }
    readonly batch: ResolvedBatch
    readonly retention: ResolvedRetention
    readonly store: ResolvedStore
    readonly stdout: boolean
    readonly forward: false | 'forward' | 'both'
    readonly fallback: 'local' | 'drop'
    readonly collect: boolean
    readonly collectorHeartbeatMs: number

    /** when a collector last announced itself (forwarders), or never. */
    collectorSeenAt: number

    /** rows forwarded / received / written locally as fallback. */
    readonly cluster: { forwarded: number; received: number; fellBack: number }
    flusher: Task<void> | null
    wake: (() => void) | null
  }
}

/** The shapes this plugin passes around inside itself. */
export namespace Helpers {
  /** rows as plain documents: the handle is untyped on purpose (five tables, one helper). */
  export type Db = Database.Handle<Record<string, Schema.Types<Spec.Doc, Spec.Doc>>>
}
