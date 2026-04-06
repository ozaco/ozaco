import type { EmptyType } from 'std:shared'

import { EVENT } from '../const'
import type { EventSource, EventSourceListener, EventSourceMap } from '../types'

export const createEvent = <T extends EventSourceMap = EmptyType>(): EventSource<T> => {
  const listeners = new Map<string, Set<EventSourceListener>>()

  const getSet = (name: string): Set<EventSourceListener> => {
    let set = listeners.get(name)
    if (!set) {
      set = new Set()
      listeners.set(name, set)
    }
    return set
  }

  const on = <K extends keyof T & string>(
    name: K,
    listener: EventSourceListener<T[K]>,
  ): (() => void) => {
    const set = getSet(name)
    set.add(listener as EventSourceListener)
    return () => {
      set.delete(listener as EventSourceListener)
    }
  }

  const once = <K extends keyof T & string>(
    name: K,
    listener: EventSourceListener<T[K]>,
  ): (() => void) => {
    const wrapper = ((...args: T[K]) => {
      set.delete(wrapper as EventSourceListener)
      return listener(...args)
    }) as EventSourceListener<T[K]>

    const set = getSet(name)
    set.add(wrapper as EventSourceListener)

    return () => {
      set.delete(wrapper as EventSourceListener)
    }
  }

  const off = <K extends keyof T & string>(name: K, listener?: EventSourceListener<T[K]>): void => {
    if (listener) {
      listeners.get(name)?.delete(listener as EventSourceListener)
    } else {
      listeners.delete(name)
    }
  }

  const emit = <K extends keyof T & string>(name: K, ...args: T[K]): void => {
    const set = listeners.get(name)
    if (!set || set.size === 0) {
      return
    }
    for (const listener of set) {
      listener(...args)
    }
  }

  const emitAsync = async <K extends keyof T & string>(name: K, ...args: T[K]): Promise<void> => {
    const set = listeners.get(name)
    if (!set || set.size === 0) {
      return
    }

    const promises: Promise<void>[] = []
    for (const listener of set) {
      const result = listener(...args)
      if (result && typeof (result as Promise<void>).then === 'function') {
        promises.push(result as Promise<void>)
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises)
    }
  }

  const clear = (): void => {
    listeners.clear()
  }

  const listenerCount = <K extends keyof T & string>(name: K): number =>
    listeners.get(name)?.size ?? 0

  return { _t: EVENT, on, once, off, emit, emitAsync, clear, listenerCount }
}
