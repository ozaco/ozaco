import type { Helpers } from '../types/helpers'
import type { Operation, Stream, Subscription } from '../types/operation'

import { resource } from './resource'
import { createSignal } from './signal'

export function on<T extends EventTarget, K extends Helpers.EventList<T> | (string & {})>(
  target: T,
  name: K,
): Stream<Helpers.EventTypeFromEventTarget<T, K>, never> {
  return resource(function* (provide) {
    const signal = createSignal<Event>()

    target.addEventListener(name, signal.send)

    try {
      yield* provide(
        (yield* signal) as unknown as Subscription<Helpers.EventTypeFromEventTarget<T, K>, never>,
      )
    } finally {
      target.removeEventListener(name, signal.send)
    }
  })
}

export function once<T extends EventTarget, K extends Helpers.EventList<T> | (string & {})>(
  target: T,
  name: K,
): Operation<Helpers.EventTypeFromEventTarget<T, K>> {
  return {
    *[Symbol.iterator]() {
      const subscription = yield* on(target, name)
      const next = yield* subscription.next()
      return next.value
    },
  }
}
