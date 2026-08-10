import { resource } from '../base/resource'
import type { Helpers } from '../types/helpers'
import type { Operation, Stream, Subscription } from '../types/operation'

import { createSignal } from './signal'

/** Wait once for an event on an `EventTarget`, then resume with it. */
export function once<T extends EventTarget, K extends Helpers.EventList<T> | (string & {})>(
  target: T,
  name: K,
): Operation<Helpers.EventTypeFromEventTarget<T, K>> {
  return {
    *[Symbol.iterator]() {
      const subscription = yield* on(target, name)
      const next = yield* subscription.next()
      return next.value as Helpers.EventTypeFromEventTarget<T, K>
    },
  }
}

/** Subscribe to an `EventTarget` as a {@link Stream} of events. */
export function on<T extends EventTarget, K extends Helpers.EventList<T> | (string & {})>(
  target: T,
  name: K,
): Stream<Helpers.EventTypeFromEventTarget<T, K>, never> {
  return resource(function* (provide) {
    const signal = createSignal<Event>()

    target.addEventListener(name, signal.send)

    try {
      yield* provide((yield* signal) as Subscription<Helpers.EventTypeFromEventTarget<T, K>, never>)
    } finally {
      target.removeEventListener(name, signal.send)
    }
  })
}
