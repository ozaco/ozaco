import type { EmptyType } from 'std:shared'

import type { EVENT } from './internal/const'

export interface EventEmitter<T extends EventEmitter.Map = EmptyType> {
  _t: typeof EVENT

  on<K extends keyof T & string>(name: K, listener: EventEmitter.Listener<T[K]>): () => void
  once<K extends keyof T & string>(name: K, listener: EventEmitter.Listener<T[K]>): () => void
  /**
   * Removes one listener, or — without a `listener` — drops the whole list for `name`. The
   * drop orphans the list rather than emptying it: disposers returned by earlier `on`/`once`
   * calls still point at the old array, so calling them later is a harmless no-op that never
   * touches listeners registered after the `off(name)`.
   */
  off<K extends keyof T & string>(name: K, listener?: EventEmitter.Listener<T[K]>): void
  emit<K extends keyof T & string>(name: K, ...args: T[K]): void
  emitAsync<K extends keyof T & string>(name: K, ...args: T[K]): Promise<void>
  clear(): void
  listenerCount<K extends keyof T & string>(name: K): number
}

export namespace EventEmitter {
  export type Map = Record<string, unknown[]>

  export type Listener<T extends unknown[] = unknown[]> = (...args: T) => void | Promise<void>

  export type Infer<T> = T extends EventEmitter<infer V> ? V : never

  export type InferType<T, K> = K extends keyof EventEmitter.Infer<T>
    ? EventEmitter.Infer<T>[K]
    : never
}
