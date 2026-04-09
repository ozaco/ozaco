import type { EmptyType } from 'std:shared'

import { EVENT } from '../const'
import { callListener, removeFrom } from '../internal'
import type { EventSource, EventSourceListener, EventSourceMap } from '../types'

export const createEvent = <T extends EventSourceMap = EmptyType>(): EventSource<T> => {
  const listeners = new Map<string, EventSourceListener[]>()

  const getList = (name: string): EventSourceListener[] => {
    let list = listeners.get(name)
    if (!list) {
      list = []
      listeners.set(name, list)
    }
    return list
  }

  const on = <K extends keyof T & string>(
    name: K,
    listener: EventSourceListener<T[K]>,
  ): (() => void) => {
    const list = getList(name)
    list.push(listener as EventSourceListener)
    return () => removeFrom(list, listener as EventSourceListener)
  }

  const once = <K extends keyof T & string>(
    name: K,
    listener: EventSourceListener<T[K]>,
  ): (() => void) => {
    const list = getList(name)
    const wrapper = ((...args: unknown[]) => {
      removeFrom(list, wrapper)
      return (listener as EventSourceListener)(...args)
    }) as EventSourceListener
    list.push(wrapper)
    return () => removeFrom(list, wrapper)
  }

  const off = <K extends keyof T & string>(name: K, listener?: EventSourceListener<T[K]>): void => {
    if (listener) {
      const list = listeners.get(name)
      if (list) {
        removeFrom(list, listener as EventSourceListener)
      }
    } else {
      listeners.delete(name)
    }
  }

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
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result
      }
      return
    }

    const snapshots = list.slice()
    let promises: Promise<void>[] | undefined
    for (const snapshot of snapshots) {
      const result = callListener(snapshot, args)
      if (result && typeof (result as Promise<void>).then === 'function') {
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
