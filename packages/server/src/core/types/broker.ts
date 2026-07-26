import type { Future } from 'std:effect'
import type { EventEmitter } from 'std:event'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { Action } from './action'
import type { Response } from './common'
import type { Service } from './service'
import type { Source } from './source'

export type BrokerDef = Plugin<BrokerDef.Context, unknown[], BrokerDef.Actions>

export namespace BrokerDef {
  export interface Options {
    name?: string
    nodeId?: string

    shortenCauses?: boolean

    /** emit a per-policy-layer trace (log + OTel child spans) for every dispatch — off by default */
    trace?: boolean

    services?: Record<string, Service> | undefined
  }

  export interface Context {
    name: string
    nodeId: string

    shortenCauses: boolean
    trace: boolean

    services: Map<string, Service>
    bus: EventEmitter<BrokerDef.EventMap>
  }

  export interface Actions {
    start(): Future<BrokerDef.Context>
    isStarted(): Future<boolean>
    pause(cause: string): Future<void>
    isPaused(): Future<false | string>
    resume(): Future<void>
    destroy(): Future<void>

    register(service: Service, name?: string): Future<void>

    /**
     * Is this address registered HERE — asked of the broker's own table, so the answer is always
     * definite. Uncertainty belongs to carriers: a TRANSPORT with no discovery answers
     * `nothing()`; a registry has no such excuse.
     */
    hosts(service: Service | string, path: string): Future<boolean>
    unregister(service: Service | string): Future<void>

    /**
     * Call by SERVICE plus path.
     *
     * The service object rather than a bare name, because that is what carries the types: `path` is
     * constrained to the addresses this service actually has, so a typo is a compile error, and the
     * result comes back typed with what the action returns.
     *
     * Two plain values rather than the action object it used to take. Passing the action meant the
     * broker had to ask the plugin runtime which service owned it before it could address anything,
     * and a node that holds no definition — a gateway, a relay — had nothing to pass at all. A bare
     * name is still accepted for exactly that case.
     */
    call<
      TService extends Service<AnyType, AnyType[], AnyType>,
      TPath extends Service.Paths<TService>,
    >(
      service: TService,
      path: TPath,
      sources?: Source.Any[],
      options?: BrokerDef.CallOptions,
    ): Future<Service.Returns<TService, TPath>>

    call(
      service: string,
      path: string,
      sources?: Source.Any[],
      options?: BrokerDef.CallOptions,
    ): Future<AnyType>

    /**
     * The same call, answered WHOLE — status, headers and every source the action produced.
     *
     * Not a second spelling of {@link call} but a different question. A service asking another
     * service wants what it returned and has no use for a status; a surface has to turn the answer
     * into a reply and needs all of it. Collapsing the two meant every ordinary caller unwrapped an
     * envelope to pay for a case that was not theirs.
     */
    exchange<
      TService extends Service<AnyType, AnyType[], AnyType>,
      TPath extends Service.Paths<TService>,
    >(
      service: TService,
      path: TPath,
      sources?: Source.Any[],
      options?: BrokerDef.CallOptions,
    ): Future<Response<Service.Returns<TService, TPath>>>

    exchange(
      service: string,
      path: string,
      sources?: Source.Any[],
      options?: BrokerDef.CallOptions,
    ): Future<Response<AnyType>>

    emit(name: string, payload?: unknown, groups?: ReadonlyArray<string | Service>): Future<void>

    broadcast(
      name: string,
      payload?: unknown,
      groups?: ReadonlyArray<string | Service>,
    ): Future<void>

    on<K extends keyof BrokerDef.EventMap & string>(
      name: K,
      listener: EventEmitter.Listener<BrokerDef.EventMap[K]>,
    ): Future<() => void>

    getServices(): Future<Map<string, Service>>
    listActions(): Future<ReadonlyArray<{ service: Service; action: Action }>>
  }

  export interface EventInfo {
    name: string
    payload: unknown
    groups?: ReadonlyArray<string>
  }

  export type EventMap = {
    'broker.started': []
    'broker.stopped': []
    'broker.paused': []
    'broker.resumed': []
    'broker.destroyed': []

    'service.registered': [service: Service]
    'service.unregistered': [service: Service | string]

    'event.emit': [info: BrokerDef.EventInfo]
    'event.broadcast': [info: BrokerDef.EventInfo]
  }

  export interface Settings {
    started: boolean
    paused: false | string
    destroying: boolean
  }

  export interface CallContext {
    service: Service
    serviceName: string

    action: Action
    actionKey: string
  }

  export interface CallOptions {
    /** defaults to INTERNAL: a call nobody marked as coming from outside did not come from outside */
    origin?: Source.Origin
    /** portable per-call metadata — request id, trace baggage, forwarded headers */
    meta?: Record<string, string>
  }
}
