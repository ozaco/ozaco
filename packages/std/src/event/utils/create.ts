import type { EmptyType } from 'std:shared'
import { isPromise } from 'std:shared'

import { EVENT } from '../const'
import { callListener, removeFrom } from '../internal/listeners'
import type { EventEmitter } from '../types'

export const createEvent = <T extends EventEmitter.Map = EmptyType>(): EventEmitter<T> => {
  const listeners = new Map<string, EventEmitter.Listener[]>()

  const getList = (name: string): EventEmitter.Listener[] => {
    let list = listeners.get(name)
    if (!list) {
      list = []
      listeners.set(name, list)
    }
    return list
  }

  const on = <K extends keyof T & string>(
    name: K,
    listener: EventEmitter.Listener<T[K]>,
  ): (() => void) => {
    const list = getList(name)
    list.push(listener as EventEmitter.Listener)
    return () => removeFrom(list, listener as EventEmitter.Listener)
  }

  const once = <K extends keyof T & string>(
    name: K,
    listener: EventEmitter.Listener<T[K]>,
  ): (() => void) => {
    const list = getList(name)
    const wrapper = ((...args: unknown[]) => {
      removeFrom(list, wrapper)
      return (listener as EventEmitter.Listener)(...args)
    }) as EventEmitter.Listener
    list.push(wrapper)
    return () => removeFrom(list, wrapper)
  }

  const off = <K extends keyof T & string>(
    name: K,
    listener?: EventEmitter.Listener<T[K]>,
  ): void => {
    if (listener) {
      const list = listeners.get(name)
      if (list) {
        removeFrom(list, listener as EventEmitter.Listener)
      }
    } else {
      listeners.delete(name)
    }
  }

  // Fire-and-forget: listener results are discarded. A listener that THROWS synchronously
  // propagates out of `emit` and the remaining listeners in that snapshot are not called; an
  // async listener that REJECTS is never awaited, so its rejection is unhandled at the runtime
  // level (use `emitAsync` to observe it). Pinned by tests/event/emitter.test.ts.
  const emit = <K extends keyof T & string>(name: K, ...args: T[K]): void => {
    const list = listeners.get(name)
    if (!list) {
      return
    }

    const len = list.length
    if (len === 0) {
      return
    }

    if (len === 1) {
      callListener(list[0]!, args)
      return
    }

    const snapshots = list.slice()
    for (const snapshot of snapshots) {
      callListener(snapshot, args)
    }
  }

  const emitAsync = async <K extends keyof T & string>(name: K, ...args: T[K]): Promise<void> => {
    const list = listeners.get(name)
    if (!list) {
      return
    }

    const len = list.length
    if (len === 0) {
      return
    }

    if (len === 1) {
      const result = callListener(list[0]!, args)
      if (isPromise(result)) {
        await result
      }
      return
    }

    const snapshots = list.slice()
    let promises: Promise<void>[] | undefined
    for (const snapshot of snapshots) {
      const result = callListener(snapshot, args)
      if (isPromise(result)) {
        if (!promises) {
          promises = []
        }
        promises.push(result as Promise<void>)
      }
    }

    if (promises) {
      await Promise.all(promises)
    }
  }

  const clear = (): void => {
    listeners.clear()
  }

  const listenerCount = <K extends keyof T & string>(name: K): number =>
    listeners.get(name)?.length ?? 0

  return { _t: EVENT, on, once, off, emit, emitAsync, clear, listenerCount }
}
