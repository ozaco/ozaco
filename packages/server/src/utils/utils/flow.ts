import type { Flow, Operation, Subscription } from 'std:effect'
import { createSignal, fork, isOperation, race, resource, sleep } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { BatchOptions, FlowOperator, PipeFlow } from '../types'

/**
 * Apply {@link FlowOperator}s to a source flow left-to-right. The result is itself a plain,
 * re-subscribable flow — every subscription re-runs the whole chain from scratch.
 */
export const pipeFlow: PipeFlow = (
  source: Flow<AnyType, AnyType>,
  ...operators: FlowOperator<AnyType, AnyType, AnyType>[]
): Flow<AnyType, AnyType> => operators.reduce((flow, operator) => operator(flow), source)

/**
 * Transform every item of a flow. `fn` may return a plain value or an {@link Operation} producing
 * it (detected with `isOperation` — a mapped value that is itself operation-shaped would be
 * evaluated, so wrap such values in an operation explicitly). The close value passes through.
 */
export const mapFlow =
  <T, R>(fn: (value: T) => R | Operation<R>) =>
  <TClose>(source: Flow<T, TClose>): Flow<R, TClose> => ({
    *[Symbol.iterator]() {
      const subscription = yield* source

      return {
        *next() {
          const item = yield* subscription.next()
          if (item.done) {
            return item
          }
          const mapped = fn(item.value)
          const value = isOperation<R>(mapped) ? yield* mapped : mapped
          return { done: false, value } as IteratorResult<R, TClose>
        },
      }
    },
  })

/**
 * Keep only the items for which `fn` returns `true`. `fn` may return a plain boolean or an
 * {@link Operation} producing one. The close value passes through.
 */
export const filterFlow =
  <T>(fn: (value: T) => boolean | Operation<boolean>) =>
  <TClose>(source: Flow<T, TClose>): Flow<T, TClose> => ({
    *[Symbol.iterator]() {
      const subscription = yield* source

      return {
        *next() {
          while (true) {
            const item = yield* subscription.next()
            if (item.done) {
              return item
            }
            const verdict = fn(item.value)
            const keep = isOperation<boolean>(verdict) ? yield* verdict : verdict
            if (keep) {
              return item
            }
          }
        },
      }
    },
  })

/**
 * Run a side effect for every item without changing it. `fn` may return an {@link Operation},
 * which is evaluated before the item is passed on; any other return value is ignored.
 */
export const tapFlow =
  <T>(fn: (value: T) => unknown) =>
  <TClose>(source: Flow<T, TClose>): Flow<T, TClose> => ({
    *[Symbol.iterator]() {
      const subscription = yield* source

      return {
        *next() {
          const item = yield* subscription.next()
          if (!item.done) {
            const effect = fn(item.value)
            if (isOperation(effect)) {
              yield* effect
            }
          }
          return item
        },
      }
    },
  })

/**
 * Group items into batches of `size`, optionally flushing a partial batch once
 * {@link BatchOptions.maxWaitMs} has elapsed since the first buffered item. The remainder is
 * flushed before close and the close value propagates. No item is ever lost: a forked pump moves
 * source items into owned state, and the consumer only ever races on the wake-up side.
 */
export const batchFlow =
  <T>(options: BatchOptions) =>
  <TClose>(source: Flow<T, TClose>): Flow<readonly T[], TClose> =>
    resource<Subscription<readonly T[], TClose>>(function* (provide) {
      const size = Math.max(1, Math.floor(options.size))
      const { maxWaitMs } = options

      const buffered: { value: T; at: number }[] = []
      let closed: { value: TClose } | undefined

      // Wake-ups are HINTS only: the consumer re-checks `buffered`/`closed` after every wake, so a
      // notification lost to a halted race loser can never lose an item — items live in `buffered`.
      const wake = createSignal<void, never>()
      const wakeSubscription = yield* wake

      // The pump owns the source subscription: racing `subscription.next()` against `sleep()`
      // directly would drop an in-flight item whenever the timer wins and the pull is halted.
      yield* fork(function* () {
        const subscription = yield* source
        let done = false
        while (!done) {
          const item = yield* subscription.next()
          if (item.done) {
            closed = { value: item.value }
            done = true
          } else {
            buffered.push({ value: item.value, at: Date.now() })
          }
          wake.send()
        }
      })

      const takeBatch = (count: number): IteratorResult<readonly T[], TClose> => ({
        done: false,
        value: buffered.splice(0, count).map(entry => entry.value),
      })

      yield* provide({
        *next() {
          while (true) {
            if (buffered.length >= size) {
              return takeBatch(size)
            }
            if (closed !== undefined) {
              if (buffered.length > 0) {
                return takeBatch(buffered.length)
              }
              return { done: true, value: closed.value } as IteratorResult<readonly T[], TClose>
            }
            if (buffered.length > 0 && maxWaitMs !== undefined) {
              const oldest = buffered[0]!
              const remainingMs = oldest.at + maxWaitMs - Date.now()
              if (remainingMs <= 0) {
                return takeBatch(buffered.length)
              }
              yield* race([wakeSubscription.next(), sleep(remainingMs)])
            } else {
              yield* wakeSubscription.next()
            }
          }
        },
      })
    })

/**
 * Consume a flow to completion and return its close value. A `Result.Failure` close (a truncated
 * source) is RAISED instead of returned, so truncation cannot masquerade as completion.
 */
export function* drainFlow<T, TClose>(source: Flow<T, TClose>): Operation<TClose> {
  const subscription = yield* source

  let item = yield* subscription.next()
  while (!item.done) {
    item = yield* subscription.next()
  }

  if (isFailure(item.value)) {
    return yield* item.value
  }

  return item.value
}

/**
 * Gather every item of a flow into an array. Like {@link drainFlow}, a `Result.Failure` close is
 * raised; a clean close value is discarded.
 */
export function* collectFlow<T>(source: Flow<T, unknown>): Operation<readonly T[]> {
  const subscription = yield* source
  const items: T[] = []

  let item = yield* subscription.next()
  while (!item.done) {
    items.push(item.value)
    item = yield* subscription.next()
  }

  if (isFailure(item.value)) {
    return yield* item.value
  }

  return items as readonly T[]
}
