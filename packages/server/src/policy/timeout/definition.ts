import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import type { Reply } from 'server:core'
import { attempt, race, sleep } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { Result } from 'std:result'

import type { TimeoutOptions, TimeoutOverride, TimeoutState } from './types'

const DEFAULT_MS = 30_000

interface Arm<T> {
  readonly t: string
  readonly value: T
}

/** Tags a race arm so the winner is identifiable. */
const arm = <T>(t: string, factory: () => Operation<T>): Operation<Arm<T>> => ({
  *[Symbol.iterator]() {
    const value = yield* factory()

    return { t, value }
  },
})

const overrideOf = (override: object | boolean | undefined): TimeoutOverride | undefined =>
  typeof override === 'object' ? (override as TimeoutOverride) : undefined

/**
 * The deadline layer (innermost, `PolicyPriority.timeout`): races the rest of the dispatch against
 * `ms`. Losing the race HALTS the inner dispatch — the layer deliberately abandons the work; the
 * broker's fulfillment wrapper underneath owns the outcome bookkeeping — and raises
 * `CoreErrors.TimeoutPending`, observable by every outer layer. Streaming dispatches skip the
 * layer unless the action opts in via `policies: { timeout: { ms } }`.
 */
export const TimeoutPolicy = definePolicy<TimeoutOptions, TimeoutState>({
  name: 'timeout',
  priority: PolicyPriority.timeout,
  skipStreaming: true,
  *setup(options) {
    return { ms: options.ms ?? DEFAULT_MS }
  },
  *apply({ state, override, next }) {
    const ms = overrideOf(override)?.ms ?? state.ms

    if (ms <= 0) {
      return yield* next()
    }

    const winner = (yield* race([
      arm('done', () => attempt(() => next())),
      arm('timeout', () => sleep(ms)),
    ])) as Arm<unknown>

    if (winner.t === 'timeout') {
      return yield* fail(
        CoreErrors.TimeoutPending,
        `policy timeout after ${ms}ms — outcome unknown`,
        'policy:timeout',
      )
    }

    const outcome = winner.value as Result<Reply>

    if (isFailure(outcome)) {
      return yield* outcome
    }

    return outcome.value
  },
})
