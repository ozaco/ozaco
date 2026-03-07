import { type BlobType, type EmptyType, isPromise, type Writable } from 'std:shared'

import { EVENT } from '../const'
import type { EventEmitter, EventEmitterListener, EventEmitterMap } from '../types'

export const createEvent = <M extends EventEmitterMap = EmptyType>(): EventEmitter<M> => {
  const event = {
    _t: EVENT,
  } as Writable<EventEmitter<M>>

  const eventListeners = new Map<string, EventEmitterListener<unknown>[]>()

  event.addEventType = () => event as BlobType

  event.on = (eventName: BlobType, listener: EventEmitterListener<BlobType>): BlobType => {
    const listeners = eventListeners.get(eventName) ?? []

    eventListeners.set(eventName, [...listeners, listener])

    return event
  }

  event.off = (listener: EventEmitterListener<BlobType>) => {
    for (const [eventName, listeners] of eventListeners.entries()) {
      if (listeners.includes(listener)) {
        eventListeners.set(
          eventName,
          listeners.filter(l => l !== listener),
        )
      }
    }

    return event
  }

  event.emit = (eventName: BlobType, payload: BlobType): BlobType => {
    const listeners = eventListeners.get(eventName) ?? []

    const promises: Promise<void>[] = []

    for (const listener of listeners) {
      const result = listener(payload)

      if (isPromise(result)) {
        promises.push(result)
      }
    }

    if (promises.length > 0) {
      return Promise.allSettled(promises).then(() => void 0)
    }

    return void 0
  }

  event.removeAllListeners = (): BlobType => {
    eventListeners.clear()

    return event
  }

  event.removeListeners = (eventName: BlobType): BlobType => {
    eventListeners.delete(eventName)

    return event
  }

  event.listeners = (eventName: BlobType) => {
    return eventListeners.get(eventName) ?? []
  }

  event.listenerCount = (eventName: BlobType) => {
    return eventListeners.get(eventName)?.length ?? 0
  }

  return event
}
