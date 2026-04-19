import type { EmptyType } from 'std:shared'

import type { EVENT } from './const'

export type EventSourceMap = Record<string, unknown[]>

export type EventSourceListener<T extends unknown[] = unknown[]> = (
  ...args: T
) => void | Promise<void>

export interface EventSource<T extends EventSourceMap = EmptyType> {
  _t: typeof EVENT

  on<K extends keyof T & string>(name: K, listener: EventSourceListener<T[K]>): () => void
  once<K extends keyof T & string>(name: K, listener: EventSourceListener<T[K]>): () => void
  off<K extends keyof T & string>(name: K, listener?: EventSourceListener<T[K]>): void
  emit<K extends keyof T & string>(name: K, ...args: T[K]): void
  emitAsync<K extends keyof T & string>(name: K, ...args: T[K]): Promise<void>
  clear(): void
  listenerCount<K extends keyof T & string>(name: K): number
}

export namespace Helpers {
  export type InferEventSource<T> = T extends EventSource<infer V> ? V : never

  export type InferEventType<T, K> = K extends keyof Helpers.InferEventSource<T>
    ? Helpers.InferEventSource<T>[K]
    : never
}
