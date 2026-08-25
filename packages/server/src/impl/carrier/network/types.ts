import type { CarrierDef, ServerDef } from 'server:core'
import type { Operation, Queue } from 'std:effect'

import type { TransportDef } from 'transport:core'

export namespace NetworkCarrierDef {
  export interface PresenceOptions {
    /** heartbeat period. Default 5000. */
    readonly heartbeatMs?: number | undefined

    /** a member unseen this long is gone. Default 3 × heartbeat. */
    readonly ttlMs?: number | undefined

    /** how long `send` waits for a live member when only draining ones are known. Default 2000. */
    readonly waitMs?: number | undefined
  }

  export interface Options {
    /** The transport plugin to ride (pinned). Default: the most recently installed transport. */
    readonly transport?: TransportDef.Handle | undefined

    /** How long an output/input lane waits for its other end. Default 5000. */
    readonly laneTimeoutMs?: number | undefined

    /** Presence (heartbeats under `presence.<instance>`): `send` fails `server.unavailable` at
     * once when no member serves a service, drains route around leaving nodes. `false` = the
     * optimistic behaviour (the transport alone decides). Default on. */
    readonly presence?: PresenceOptions | false | undefined
  }

  /** What a node announces. */
  export interface Heartbeat {
    readonly k: 'presence' | 'leave' | 'hello'
    readonly instance: string
    readonly serviceId: string
    readonly services: readonly { readonly name: string; readonly version: string }[]
    readonly draining: boolean
    readonly ts: number
  }

  export interface Presence {
    readonly heartbeatMs: number
    readonly ttlMs: number
    readonly waitMs: number

    /** service → instance → member */
    readonly members: Map<string, Map<string, CarrierDef.Member>>
    draining: boolean
  }

  export interface State {
    readonly actions: TransportDef.Actions
    readonly transport: string
    readonly laneTimeoutMs: number

    /** lane pipes that must outlive the reply that announced them. */
    readonly jobs: Queue<() => Operation<void>, void>

    /** services served here → their transport stop. */
    readonly serving: Map<string, TransportDef.Stop>
    readonly presence: Presence | null

    /** the kernel this carrier serves (null when installed outside createServer). */
    readonly kernel: ServerDef.Context | null
  }
}
