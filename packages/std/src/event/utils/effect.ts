import type { Flow, Operation } from 'std:effect'
import { createQueue, createSignal, each, ensure, resource } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { EventEmitter } from '../types'

/** The emitter's `name` events as a Flow; the listener is detached when the flow is torn down. */
export const useEvent = <
  T extends EventEmitter<AnyType>,
  K extends keyof EventEmitter.Infer<T> & string,
>(
  target: T,
  name: K,
): Flow<EventEmitter.InferType<T, K>, never> =>
  resource(function* (provide) {
    const signal = createSignal<EventEmitter.InferType<T, K>, never>()
    const handler = (...args: AnyType[]) => signal.send(args as EventEmitter.InferType<T, K>)

    target.on(name, handler)

    try {
      yield* provide(yield* signal)
    } finally {
      target.off(name, handler)
    }
  })

/** Run `handler` for every `name` event until the scope ends. */
export function* onEvent<
  T extends EventEmitter<AnyType>,
  K extends keyof EventEmitter.Infer<T> & string,
>(
  target: T,
  name: K,
  handler: (...args: EventEmitter.InferType<T, K>) => Operation<void>,
): Operation<void> {
  const stream = useEvent(target, name)

  for (const args of yield* each(stream)) {
    yield* handler(...args)
    yield* each.next()
  }
}

/** The next `name` event's arguments. */
export function* useEventOnce<
  T extends EventEmitter<AnyType>,
  K extends keyof EventEmitter.Infer<T> & string,
>(target: T, name: K): Operation<EventEmitter.InferType<T, K>> {
  const subscription = yield* useEvent(target, name)
  const next = yield* subscription.next()

  return next.value
}

/** `name` events as a Flow that BUFFERS: events emitted before `next()` is called are kept, not
 * dropped (a signal drops what nobody is waiting for). */
export function* useBufferedEvent<
  T extends EventEmitter<AnyType>,
  K extends keyof EventEmitter.Infer<T> & string,
>(target: T, name: K): Flow<EventEmitter.InferType<T, K>, never> {
  const queue = createQueue<EventEmitter.InferType<T, K>, never>()
  const handler = (...args: AnyType[]) => queue.add(args as EventEmitter.InferType<T, K>)

  target.on(name, handler)

  yield* ensure(() => {
    target.off(name, handler)
  })

  return { next: queue.next }
}
