import type { Database, Schema, Spec } from 'db:core'
import type { ObserveDef, ServerDef } from 'server:core'
import type { Queue, Task } from 'std:effect'
import type { AnyType } from 'std:shared'

export namespace ObservePluginDef {
  export interface Retention {
    /** how long request/span rows are kept. Default 7 days. */
    readonly requestsMs?: number | undefined

    /** how long log/event rows are kept. Default 1 day. */
    readonly logsMs?: number | undefined

    /** how often the pruner runs. Default 10 minutes; 0 = never. */
    readonly everyMs?: number | undefined
  }

  export interface Batch {
    /** rows per insert batch. Default 200. */
    readonly size?: number | undefined

    /** max time a row waits in memory. Default 50. */
    readonly ms?: number | undefined

    /** rows held before the oldest are dropped (`stats().dropped`). Default 10 000. */
    readonly maxPending?: number | undefined
  }

  export interface Options {
    /** Where the rows go: by default a private `DbClient` over the app's adapter (installed
     * before the server); pass an adapter plugin entry (`SqliteAdapter.use({ path })`) to keep
     * observability in its own database. */
    readonly db?: ServerDef.PluginLike | undefined

    /** Serve the dev console at `/_observe` (needs an edge). Default false. */
    readonly console?: boolean | undefined

    /** Mirror every request/failure/log line to stdout (dev). Default false. */
    readonly mirror?: boolean | undefined
    readonly retention?: Retention | undefined
    readonly batch?: Batch | undefined

    /** Send every row to the cluster's collector over the carrier (`true`: forward only,
     * `'both'`: forward AND keep a local copy). Needs a `NetworkCarrier`. Default false. */
    readonly forward?: boolean | 'both' | undefined

    /** While forwarding and no collector is alive: `local` writes here, `drop` discards.
     * Default `local`. */
    readonly fallback?: 'local' | 'drop' | undefined

    /** Receive forwarded rows from the cluster into this store (the gateway, or a dedicated
     * observability node). Default false. */
    readonly collect?: boolean | undefined

    /** collector heartbeat period. Default 5000 (a collector unseen for 3× is gone). */
    readonly collectorHeartbeatMs?: number | undefined
  }

  /** A unit of work for the store scope (the private db lives in its own scope). */
  export interface Job {
    readonly body: (db: Database.Handle<AnyType>) => AnyType
    readonly resolve: (value: unknown) => void
    readonly reject: (error: unknown) => void
  }

  export interface ResolvedBatch {
    readonly size: number
    readonly ms: number
    readonly maxPending: number
  }

  export interface ResolvedRetention {
    readonly requestsMs: number
    readonly logsMs: number
    readonly everyMs: number
  }

  export interface State {
    readonly jobs: Queue<Job, void>
    readonly pending: ObserveDef.Event[]
    readonly stats: { recorded: number; dropped: number }
    readonly batch: ResolvedBatch
    readonly retention: ResolvedRetention
    readonly mirror: boolean
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
