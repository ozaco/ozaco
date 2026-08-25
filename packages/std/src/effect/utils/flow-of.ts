import { isFailure } from 'std:result'

import { lift } from '../base/lift'
import { spawn } from '../base/spawn'
import type { Flow, Operation } from '../types/operation'

import { attempt } from './attempt'
import { createQueue } from './queue'

/**
 * A Flow written as ONE generator — no hand-rolled subscription objects: `emit(value)` sends
 * the next item, a plain `return` ENDS the flow (the returned value is its close value; a
 * raised failure closes the flow with that failure). The body runs as a child of the CONSUMING
 * scope: halting the consumer halts the producer.
 *
 *   const ticks = flowOf<number>(function* (emit) {
 *     for (let at = 0; at < 3; at += 1) {
 *       yield* emit(at)
 *       yield* sleep(100)
 *     }
 *   })
 */
export const flowOf = <T, TReturn = void>(
  body: (emit: (value: T) => Operation<void>) => Operation<TReturn>,
): Flow<T, TReturn> => ({
  *[Symbol.iterator]() {
    const queue = createQueue<T, TReturn>()

    const emit = lift((value: T) => {
      queue.add(value)
    }) as (value: T) => Operation<void>

    yield* spawn(function* () {
      const outcome = yield* attempt(() => body(emit))
      queue.close((isFailure(outcome) ? outcome : outcome.value) as TReturn)
    })

    return queue
  },
})
