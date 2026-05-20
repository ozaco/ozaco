import type { Future } from 'std:effect'
import type { EventEmitter } from 'std:event'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { Action } from './action'
import type { Service } from './service'

export type BrokerDef = Plugin<BrokerDef.Context, unknown, unknown[], BrokerDef.Actions>

export namespace BrokerDef {
  export interface Options {
    name?: string
    nodeId?: string

    services?: Record<string, Service> | undefined
  }

  export interface Context {
    name: string
    nodeId: string

    services: Map<string, Service>
    bus: EventEmitter<BrokerDef.EventMap>
  }

  export interface Actions {
    start(): Future<BrokerDef.Context, unknown>
    isStarted(): Future<boolean, unknown>
    pause(cause: string): Future<void, unknown>
    isPaused(): Future<false | string, unknown>
    resume(): Future<void, unknown>
    destroy(): Future<void, unknown>

    register(service: Service, name?: string): Future<void, unknown>
    unregister(service: Service | string): Future<void, unknown>

    call<TArgs extends unknown[] = AnyType[], TReturn = AnyType, TError = unknown>(
      target: Action<TArgs, TReturn, TError>,
      params?: NoInfer<TArgs>,
      options?: unknown,
    ): Future<NoInfer<TReturn>, unknown>

    emit(
      name: string,
      payload?: unknown,
      groups?: ReadonlyArray<string | Service>,
    ): Future<void, unknown>

    broadcast(
      name: string,
      payload?: unknown,
      groups?: ReadonlyArray<string | Service>,
    ): Future<void, unknown>

    on<K extends keyof BrokerDef.EventMap & string>(
      name: K,
      listener: EventEmitter.Listener<BrokerDef.EventMap[K]>,
    ): Future<() => void, unknown>

    getService: {
      (name: string): Future<Service, unknown>
      (service: Service): Future<string, unknown>
    }
    getServices(): Future<Map<string, Service>, unknown>
    listActions(): Future<ReadonlyArray<{ service: Service; action: Action }>, unknown>
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

    raw: {
      req: unknown
      res: unknown
    }
  }
}
