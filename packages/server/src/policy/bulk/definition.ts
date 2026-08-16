import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import { attempt, race, sleep, withResolvers } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail, isFailure } from 'std:result'

import type { BulkLane, BulkOptions, BulkOverride, BulkState } from './types'

const DEFAULT_MAX_CONCURRENT = 10
const DEFAULT_MAX_QUEUE = 100
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000

interface Arm<T> {
  readonly t: string
  readonly value: T
}

/** Tags a race arm so the winner is identifiable. Losing arms are halted, never the dispatch. */
const arm = <T>(t: string, factory: () => Operation<T>): Operation<Arm<T>> => ({
  *[Symbol.iterator]() {
    const value = yield* factory()

    return { t, value }
  },
})

const overrideOf = (override: object | boolean | undefined): BulkOverride | undefined =>
  typeof override === 'object' ? (override as BulkOverride) : undefined

/** Action identity: the first two `\0` segments of the dispatch key (`service\0action`). */
const laneKeyOf = (key: string): string => {
  const separator = key.indexOf('\0', key.indexOf('\0') + 1)

  return separator === -1 ? key : key.slice(0, separator)
}

/** Hand the freed slot to the next queued dispatch, or shrink the running count. */
const release = (lane: BulkLane): void => {
  const waiter = lane.queue.shift()

  if (waiter) {
    waiter.resolve(undefined as void)
  } else {
    lane.active -= 1
  }
}

/** Wait FIFO for a slot; `false` means the wait timed out (never holding a slot afterwards). */
function* enqueue(lane: BulkLane, queueTimeoutMs: number): Operation<boolean> {
  const waiter = withResolvers<void>('bulkhead queue slot')

  lane.queue.push(waiter)

  let granted = false

  try {
    const first = (yield* race([
      arm('granted', () => waiter.operation),
      arm('timeout', () => sleep(queueTimeoutMs)),
    ])) as Arm<unknown>

    granted = first.t === 'granted'
  } finally {
    const index = lane.queue.indexOf(waiter)

    if (index !== -1) {
      lane.queue.splice(index, 1)
    } else if (!granted) {
      // the slot was granted in the same instant we bailed — hand it straight back
      release(lane)
    }
  }

  return granted
}

/**
 * The bulkhead layer (`PolicyPriority.bulk`): at most `maxConcurrent` dispatches per action run at
 * once; the overflow waits in a FIFO queue bounded by `maxQueue` and `queueTimeoutMs`. Slots are
 * released on every exit path — failures never leak permits — and a freed slot is handed directly
 * to the next queued dispatch, preserving arrival order.
 */
export const BulkPolicy = definePolicy<BulkOptions, BulkState>({
  name: 'bulk',
  priority: PolicyPriority.bulk,
  *setup(options) {
    return {
      lanes: new Map<string, BulkLane>(),
      maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxQueue: options.maxQueue ?? DEFAULT_MAX_QUEUE,
      queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
    }
  },
  *apply({ ctx, state, override, next }) {
    const tuned = overrideOf(override)
    const maxConcurrent = tuned?.maxConcurrent ?? state.maxConcurrent
    const maxQueue = tuned?.maxQueue ?? state.maxQueue
    const queueTimeoutMs = tuned?.queueTimeoutMs ?? state.queueTimeoutMs
    const laneKey = laneKeyOf(ctx.key)
    const lane = state.lanes.get(laneKey) ?? { active: 0, queue: [] }

    state.lanes.set(laneKey, lane)

    if (lane.active < maxConcurrent) {
      lane.active += 1
    } else {
      if (lane.queue.length >= maxQueue) {
        return yield* fail(CoreErrors.Unavailable, 'bulkhead queue is full', 'policy:bulk')
      }

      const granted = yield* enqueue(lane, queueTimeoutMs)

      if (!granted) {
        return yield* fail(
          CoreErrors.Unavailable,
          `bulkhead queue wait exceeded ${queueTimeoutMs}ms`,
          'policy:bulk queue-timeout',
        )
      }
    }

    try {
      const outcome = yield* attempt(() => next())

      if (isFailure(outcome)) {
        return yield* outcome
      }

      return outcome.value
    } finally {
      release(lane)

      if (lane.active === 0 && lane.queue.length === 0) {
        state.lanes.delete(laneKey)
      }
    }
  },
})
