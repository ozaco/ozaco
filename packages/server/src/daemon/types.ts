import type { GatewayInfo, GatewayServeOptions, Service } from 'server:core'
import type { Operation } from 'std:effect'

/** Which role this process plays — resolved from the `SERVICE` env var. */
export type DaemonKind = 'monolith' | 'gateway' | 'service'

export interface DaemonRuntime {
  readonly kind: DaemonKind
  /** The owned service name when `kind === 'service'`. */
  readonly service?: string | undefined
  readonly env: Record<string, string | undefined>
}

export interface DaemonModule {
  readonly name: string
  readonly service: Service
  /** Gateway mount prefix (default `/${name}`). */
  readonly prefix?: string | undefined
  /** Skip the module entirely when false (feature flags, missing credentials …). */
  readonly when?: ((runtime: DaemonRuntime) => boolean) | undefined
  /** Extra installs for the OWNING process only (db adapters, providers …). */
  readonly setup?: ((runtime: DaemonRuntime) => Operation<void>) | undefined
}

export interface DaemonOptions {
  readonly modules: readonly DaemonModule[]
  /** Per-process infrastructure (transports, gateway adapter, auth …) — runs before modules. */
  readonly base?: ((runtime: DaemonRuntime) => Operation<void>) | undefined
  /** Runs after everything is registered/mounted/started. */
  readonly ready?:
    | ((runtime: DaemonRuntime, mounted: readonly DaemonModule[]) => Operation<void>)
    | undefined
  readonly serve?: GatewayServeOptions | undefined
  /** Injectable environment (tests); defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined
}

export interface DaemonInfo {
  readonly runtime: DaemonRuntime
  readonly owned: readonly string[]
  readonly mounted: readonly string[]
  readonly gateway?: GatewayInfo | undefined
}
