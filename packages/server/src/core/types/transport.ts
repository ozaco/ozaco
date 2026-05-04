import type { Future } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Action, ActionRequest } from './action'
import type { Service } from './service'

export type TransportContext = unknown

export interface CallOptions {
  parent?: ActionRequest | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export interface TransportActions extends Record<string, AnyType> {
  call<TReturn, TError>(
    action: Action<[AnyType], TReturn, TError>,
    body: unknown,
    options?: CallOptions,
  ): Future<TReturn, TError | 'transport'>

  mount(service: Service): Future<void, unknown>
  unmount(service: Service): Future<void, unknown>
  settings<T extends Record<string, AnyType>>(
    options?: T,
  ): Future<T & { transport: AnyType }, unknown>

  start(): Future<void, unknown>
  isStarted(): Future<boolean, unknown>
  pause(cause: string): Future<void, unknown>
  isPaused(): Future<false | string, unknown>
  resume(): Future<void, unknown>
  destroy(): Future<void, unknown>
}
