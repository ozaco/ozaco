import type { Operation, Stream, Subscription } from '../types/operation'

import { each } from './each'
import { isOperation } from './is'

export const streamForEach = function* <T>(
  stream: Stream<T, unknown>,
  fn: (item: T) => unknown,
): Operation<void> {
  for (const item of yield* each(stream)) {
    const step = fn(item)
    if (isOperation(step)) {
      yield* step
    }
    yield* each.next()
  }
}

export const forEachSubscriptionEvent = function* <T>(
  source: Subscription<T, unknown>,
  fn: (value: T) => unknown,
): Operation<void> {
  while (true) {
    const next = yield* source.next()
    if (next.done) {
      return
    }
    const step = fn(next.value)
    if (isOperation(step)) {
      yield* step
    }
  }
}
