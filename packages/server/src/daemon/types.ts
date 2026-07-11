import type { Operation } from 'std:effect'

export namespace DaemonDef {
  export type Strategy = 'none' | 'worker' | 'cluster'
  export type Mode = 'shared-port' | 'roles'

  /** What happens once a unit (a module's setup, or a crashed replica) has exhausted its retries.
   * `all` stops everything (the replica crashes / the whole daemon is torn down); `isolate` drops only
   * the broken unit and keeps the rest running. */
  export type FailMode = 'all' | 'isolate'

  /** Retry the failing unit before giving up. Same shape as the server retry policy: `delay` grows by
   * `backoff` each attempt, capped at `maxDelay`. `attempts` is the TOTAL tries incl. the first. */
  export interface Retry {
    attempts?: number
    delay?: number
    backoff?: number
    maxDelay?: number
  }

  /** Failure handling for module setup (in-process) and replica crashes (supervisor). A `number`
   * shorthand for `retry` sets the attempt count. Default: `{ mode: 'all' }` with no retry. */
  export interface Failure {
    mode?: FailMode
    retry?: Retry | number
  }

  /** Per-replica facts resolved from env + the spawn topology. Passed to every callback so a module
   * can decide whether it belongs in THIS process and read its configuration. */
  export interface Runtime {
    /** The full process environment — `when` predicates read arbitrary feature flags from here. */
    env: Record<string, string>
    /** Roles assigned to this replica (roles mode / worker workerData). Empty in shared-port / single. */
    roles: Set<string>
    /** True when no specific role is assigned → this replica runs every eligible module. */
    runsAll: boolean
    /** First assigned role, or null. */
    role: string | null
    /** Replica index (cluster worker id / worker threadId); -1 for the supervisor / single process. */
    index: number
    strategy: Strategy
    mode: Mode | null
    /** OS-level primary (cluster primary / main thread). */
    primary: boolean
    /** `primary && strategy !== 'none'` → forks replicas and does NOT host services itself. */
    supervisor: boolean
    /** Start the gateway with SO_REUSEPORT (cluster shared-port). */
    reusePort: boolean
  }

  /** One env-gated unit of the app: install + register + mount its services/plugins. */
  export interface Module {
    name: string
    /** Role-gate: eligible only on replicas whose roles intersect. Absent = role-independent. */
    roles?: string[]
    /** Extra predicate (e.g. a feature flag from `rt.env`). Absent = always eligible. */
    when?: (rt: Runtime) => boolean
    /** Per-module failure handling, overriding the daemon-level `failure` (retry the setup; on
     * exhaustion `all` crashes the replica, `isolate` skips just this module). */
    failure?: Failure
    /** Run only when eligible. */
    setup: (rt: Runtime) => Operation<unknown>
  }

  export interface Replicate {
    strategy: Strategy
    /** Replica count for shared-port / worker pool. Default: os.cpus().length. */
    count?: number
    /** Cluster topology. Default 'shared-port'. */
    mode?: Mode
    /** roles mode: role name → replica count (e.g. `{ auth: 2, docs: 1 }`). */
    roles?: Record<string, number>
    /** worker strategy: entry script each thread runs (re-runs your daemon main). */
    script?: string | URL
  }

  export interface Options {
    replicate?: Replicate
    /** Default failure handling for every module's setup AND for crashed replicas in the supervisor.
     * Overridable per module via `Module.failure`. Default: `{ mode: 'all' }`, no retry. */
    failure?: Failure
    /** Common bootstrap, run on every replica BEFORE modules: install logger/broker/gateway/plugins
     * (but do NOT start them — the daemon starts broker + gateway once all modules have mounted). */
    base?: (rt: Runtime) => Operation<unknown>
    /** Env-gated units assembled per replica. */
    modules: Module[]
    /** Run on every replica AFTER broker + gateway start (logging, warmup, seeding). */
    ready?: (rt: Runtime) => Operation<unknown>
  }

  export interface Context {
    options: Options
  }
}
