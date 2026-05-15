import type { Operation, Stream, Subscription } from 'std:effect'
import { createSignal, each, resource } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { EventEmitter } from '../types'

export function useEvent<T extends EventEmitter<AnyType>, K extends keyof EventEmitter.Infer<T>>(
  target: T,
  name: K,
): Stream<EventEmitter.InferType<T, K>, never> {
  return resource(function* (provide) {
    const signal = createSignal<EventEmitter>()
    const handler = (...args: AnyType) => signal.send(args)

    target.on(name as AnyType, handler)

    try {
      yield* provide(
        (yield* signal) as unknown as Subscription<EventEmitter.InferType<T, K>, never>,
      )
    } finally {
      target.off(name as AnyType, handler)
    }
  })
}

export function onEvent<T extends EventEmitter<AnyType>, K extends keyof EventEmitter.Infer<T>>(
  target: T,
  name: K,
  handler: (...args: EventEmitter.InferType<T, K>) => Operation<void>,
): Operation<void> {
  return {
    *[Symbol.iterator]() {
      const stream = useEvent(target, name)
      for (const args of yield* each(stream)) {
        yield* handler(...args)
        yield* each.next()
      }
    },
  }
}

export function useEventOnce<
  T extends EventEmitter<AnyType>,
  K extends keyof EventEmitter.Infer<T>,
>(target: T, name: K): Operation<EventEmitter.InferType<T, K>> {
  return {
    *[Symbol.iterator]() {
      const subscription = yield* useEvent(target, name)
      const next = yield* subscription.next()
      return next.value
    },
  }
}
