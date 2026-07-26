import type { Service } from 'server:core'
import type { Operation } from 'std:effect'

export namespace DaemonDef {
  /**
   * What this process is. Derived from `SERVICE` (and, in cluster mode, from being the primary) —
   * never configured by hand.
   *
   *   monolith → owns AND serves every module: one process, the whole app
   *   gateway  → serves every module's routes + docs, owns none of them
   *   service  → owns exactly one module, serves nothing
   */
  export type Kind = 'monolith' | 'gateway' | 'service'

  /** What happens once a unit (a module's assembly, or a crashed child) has exhausted its retries.
   * `all` stops everything; `isolate` drops only the broken unit and keeps the rest running. */
  export type FailMode = 'all' | 'isolate'

  /** Retry the failing unit before giving up. `delay` grows by `backoff` each attempt, capped at
   * `maxDelay`. `attempts` is the TOTAL tries incl. the first. */
  export interface Retry {
    attempts?: number
    delay?: number
    backoff?: number
    maxDelay?: number
  }

  /** Failure handling for module assembly (in-process) and child crashes (cluster supervisor). A
   * `number` shorthand for `retry` sets the attempt count. Default: `{ mode: 'all' }`, no retry. */
  export interface Failure {
    mode?: FailMode
    retry?: Retry | number
  }

  /** Per-process facts, resolved from the environment. Passed to every callback so a module can tell
   * whether it belongs here. */
  export interface Runtime {
    /** The full process environment — `when` predicates read feature flags from here. */
    env: Record<string, string>
    kind: Kind
    /** The module this process owns; null unless `kind === 'service'`. */
    service: string | null
    /** Cluster child id; -1 for the primary or a single process. */
    index: number
    /** Running under `cluster: true` (either the primary or one of its children). */
    cluster: boolean
  }

  /**
   * One unit of the app. The module NAME is its role: `SERVICE=todos` owns the module called `todos`.
   * Ownership and serving are independent — a service process owns without serving, the gateway
   * serves without owning, a monolith does both.
   */
  export interface Module {
    name: string
    /** Extra predicate (e.g. a feature flag from `rt.env`). Gates OWNERSHIP only — the gateway still
     * mounts and documents the routes without it, since the flag belongs to the owner. */
    when?: (rt: Runtime) => boolean
    /** Per-module override of the daemon-level `failure`. */
    failure?: Failure
    /**
     * The service this module owns. On the owning process the daemon runs `install(service)` then
     * `Broker.actions.register(service)` — do NOT install it yourself in `base`. Elsewhere only
     * `Gateway.actions.mount` runs, which reads static route/OpenAPI metadata and boots nothing.
     */
    service?: Service
    /** Mount prefix. Omit to keep the service off HTTP entirely (internal RPC only). */
    route?: string
    /** Extra wiring for the OWNING process, run BEFORE `service` is installed — e.g. installing a
     * provider the service depends on. Required when `service` is absent. */
    setup?: (rt: Runtime) => Operation<unknown>
  }

  export interface Options {
    /**
     * Fork one child process per module, with THIS process staying on as the gateway. Mirrors the
     * Kubernetes shape (a gateway Deployment + one Deployment per module) on a single machine; in a
     * cluster leave it off and let Kubernetes do the replicating.
     */
    cluster?: boolean
    /** Default failure handling for module assembly AND for crashed children. Default `{mode:'all'}`. */
    failure?: Failure
    /** Common bootstrap, run BEFORE modules: install logger/broker/transport/gateway (but do NOT
     * start them — the daemon starts broker + gateway once the modules are assembled). */
    base?: (rt: Runtime) => Operation<unknown>
    /** The app's units. Assembled per process according to `rt.kind`. */
    modules: Module[]
    /** Run AFTER broker + gateway start. `mounted` lists the services whose routes THIS process
     * exposed — feed it straight to `Docs.actions.from`. */
    ready?: (rt: Runtime, mounted: readonly Service[]) => Operation<unknown>
  }

  export interface Context {
    options: Options

    /** Resolved by `start()`, so it is null while the daemon is only installed. Anything wired from
     * `base` or a module reads it through `useRole` to learn what this process is. */
    runtime: Runtime | null
  }
}
