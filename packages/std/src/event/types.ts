import type { BlobType, EmptyType, IsPromise, MergeSimplified } from 'std:shared'

import type { EVENT } from './const'

export type EventEmitterMap = Record<string, unknown>
export type EventEmitterListener<T = unknown> = (payload: T) => void | Promise<void>

export interface EventEmitter<M extends EventEmitterMap = EmptyType> {
  readonly _t: typeof EVENT

  readonly addEventType: <K extends string, P>() => EventEmitter<MergeSimplified<M, { [T in K]: P }>>

  readonly on: {
    <K extends keyof M>(event: K, listener: EventEmitterListener<M[K]>): EventEmitter<M>
    <K extends string, P>(
      event: K,
      listener: EventEmitterListener<P>,
    ): EventEmitter<MergeSimplified<M, { [T in K]: P }>>
  }

  readonly off: (listener: EventEmitterListener<BlobType>) => EventEmitter<M>
  readonly emit: <K extends keyof M>(event: K, payload: M[K]) => true extends IsPromise<M[K]> ? Promise<void> : void

  readonly removeAllListeners: () => EventEmitter<EmptyType>
  readonly removeListeners: <K extends keyof M>(events: K) => EventEmitter<Omit<M, K>>

  readonly listeners: <K extends keyof M>(event: K) => ReadonlyArray<EventEmitterListener<M[K]>>
  readonly listenerCount: <K extends keyof M>(event: K) => number
}
