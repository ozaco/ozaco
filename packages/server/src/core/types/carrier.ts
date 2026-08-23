import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { StreamDef } from './stream'
import type { WireDef } from './wire'

/**
 * The carrier protocol: how a dispatch reaches a service hosted on another node (and how a
 * node serves its own). `LocalCarrier` (core) answers only in-process; `NetworkCarrier`
 * (`server:impl/carrier/network`) rides an `@ozaco/transport`.
 */
export namespace CarrierDef {
  export interface Options {
    readonly carrier: string

    /** the transport name behind it (`memory`, `nats`, …) or `local`. */
    readonly transport: string
  }

  /** An input stream the caller pipes alongside the dispatch. */
  export interface InputLane {
    readonly name: string
    readonly brand: string
    readonly source: StreamDef.Branded
  }

  /** An output stream the owner pipes back — opened by whoever consumes it, in ITS scope (the
   * handler's scope is gone by then). */

  export interface OutputLane {
    readonly name: string
    readonly brand: string
    open(): Operation<StreamDef.Branded>
  }

  export interface Sent {
    readonly reply: WireDef.Reply

    /** attach to an output lane the owner announced. */
    lane(name: string): Operation<StreamDef.Branded>
  }

  /** What the serving side gives the carrier back for one dispatch. */
  export interface Served {
    readonly value: unknown
    readonly outputs: readonly OutputLane[]
  }

  export type Server = (
    dispatch: WireDef.Dispatch,
    inputs: (name: string) => Operation<StreamDef.Branded>,
  ) => Operation<Served>

  /** One node that serves a service, as presence sees it. */
  export interface Member {
    readonly instance: string
    readonly serviceId: string

    /** the service's declared version on that node. */
    readonly version: string

    /** last heartbeat (ms). */
    readonly seenAt: number

    /** announced its departure: finishes what it has, takes nothing new. */
    readonly draining: boolean
  }

  export interface Actions {
    describe(): Operation<Options>

    /** Whether a service is reachable through this carrier (somewhere) — a live member exists. */
    hosts(service: string): Operation<boolean>

    /** Every known member of a service (live and draining), by presence. */
    members(service: string): Operation<readonly Member[]>

    /** Send a dispatch to whoever serves the service; resolves the reply (or re-raises the
     * owner's failure). */
    send(dispatch: WireDef.Dispatch, inputs: readonly InputLane[]): Operation<Sent>

    /** Serve a service hosted on this node. */
    serve(service: string, server: Server): Operation<void>

    /** Stop serving a service (in-flight work finishes; nothing new arrives). */
    unserve(service: string): Operation<void>

    /** Announce this node is leaving: members mark it `draining` and route around it. */
    leave(): Operation<void>
    emit(event: WireDef.Event): Operation<void>
    events(): Flow<WireDef.Event, never>
    cancel(cid: string): Operation<void>
    status(): Flow<'connected' | 'reconnecting' | 'closed', void>
  }

  export type Defaults = Pick<Actions, 'describe'>

  export type Handle = Plugin<Options, AnyType[], Actions>
}
