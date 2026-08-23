import type { CarrierDef, ServerDef, ServiceDef } from 'server:core'
import type { Operation } from 'std:effect'

export namespace AppDef {
  /** `monolith`: every service + the edge in one process. `gateway`: the edge only, every
   * call forwarded over the carrier. `service`: hosted services only, no edge (unless one is
   * given for health). */
  export type Role = 'monolith' | 'gateway' | 'service'

  export interface Options<
    TServices extends readonly ServiceDef.Service[] = readonly ServiceDef.Service[],
  > extends Omit<ServerDef.Options<TServices>, 'hosted'> {
    /** Default: `process.env.SERVICE ? 'service' : 'monolith'`. */
    readonly role?: Role | undefined

    /** `service` role: which declared services this node hosts. Default: `process.env.SERVICE`
     * split on commas, or all. */
    readonly hosted?: readonly string[] | undefined

    /** health endpoint path on the edge. Default `/_health`; `false` disables it. */
    readonly health?: string | false | undefined

    /** graceful stop: how long in-flight requests get after the edge pauses. Default 5000. */
    readonly drainMs?: number | undefined
    readonly listen?: ServerDef.ListenOptions | undefined

    /** Services that must have a live member before `start()` resolves (health reports
     * `ready: false` / 503 meanwhile). Default: every declared service this node does not host.
     * `[]` = start at once. */
    readonly dependsOn?: readonly string[] | undefined

    /** How long `start()` waits for `dependsOn`; past it `start()` fails `server.unavailable`.
     * Default 30 000. */
    readonly readyTimeoutMs?: number | undefined
  }

  export interface Info {
    readonly role: Role
    readonly hosted: readonly string[]
    readonly url: string | null
    readonly started: boolean

    /** every `dependsOn` service has a live member. */
    readonly ready: boolean
  }

  /** What `/_health` answers. */
  export interface Health {
    readonly ok: boolean
    readonly ready: boolean
    readonly role: Role
    readonly hosted: readonly string[]
    readonly serviceId: string
    readonly members: Readonly<Record<string, readonly CarrierDef.Member[]>>
  }

  export interface Handle<
    TServices extends readonly ServiceDef.Service[] = readonly ServiceDef.Service[],
  > {
    readonly server: ServerDef.Handle<TServices>
    readonly role: Role
    start(): Operation<Info>
    stop(): Operation<void>
    info(): Operation<Info>
    health(): Operation<Health>
  }

  /** The installed app's state. */
  export interface State {
    readonly role: AppDef.Role
    readonly hosted: readonly string[]
    readonly options: AppDef.Options
    readonly server: ServerDef.Handle
    url: string | null
    started: boolean
    ready: boolean
  }
}
