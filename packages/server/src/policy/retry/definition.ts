import { CoreErrors, definePolicy, PolicyPriority, toWireFailure } from 'server:core'
import type { Wire } from 'server:core'
import { attempt, backoffDelay, sleep } from 'std:effect'
import { appendCauses, isFailure } from 'std:result'

import type { RetryOptions, RetryOverride, RetryState } from './types'

const DEFAULT_ATTEMPTS = 3
const DEFAULT_DELAY_MS = 250
const DEFAULT_FACTOR = 2
const DEFAULT_MAX_DELAY_MS = 30_000

const overrideOf = (override: object | boolean | undefined): RetryOverride | undefined =>
  typeof override === 'object' ? (override as RetryOverride) : undefined

/**
 * Default predicate: only raised carrier-level failures that are safe to re-dispatch. Never
 * `TimeoutPending` (the outcome is unknown — reconcile, don't re-execute) and never business
 * `failure` replies.
 */
const defaultWhen = (failure: Wire.Failure, raised: boolean): boolean =>
  raised &&
  (failure.error === CoreErrors.TimeoutUnreached || failure.error === CoreErrors.Unavailable)

/**
 * The retry layer (`PolicyPriority.retry`): re-dispatches matched failures with exponential
 * backoff. Both raised failures and `failure` replies are offered to `when` (with the `raised`
 * flag), so business errors CAN opt in — the default retries only raised `TimeoutUnreached` /
 * `Unavailable`. On exhaustion the last raised failure re-raises with a
 * `policy:retry n attempts exhausted` cause appended; an exhausted `failure` reply returns as-is.
 */
export const RetryPolicy = definePolicy<RetryOptions, RetryState>({
  name: 'retry',
  priority: PolicyPriority.retry,
  skipStreaming: true,
  *setup(options) {
    return {
      attempts: Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS),
      delayMs: options.delayMs ?? DEFAULT_DELAY_MS,
      factor: options.factor ?? DEFAULT_FACTOR,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      when: options.when ?? defaultWhen,
    }
  },
  *apply({ state, override, next }) {
    const tuned = overrideOf(override)
    const attempts = Math.max(1, tuned?.attempts ?? state.attempts)
    const when = tuned?.when ?? state.when
    const backoff = {
      delayMs: tuned?.delayMs ?? state.delayMs,
      factor: tuned?.factor ?? state.factor,
      maxDelayMs: tuned?.maxDelayMs ?? state.maxDelayMs,
    }

    let tried = 0

    while (true) {
      tried += 1

      const outcome = yield* attempt(() => next())

      if (isFailure(outcome)) {
        if (tried < attempts && when(toWireFailure(outcome), true)) {
          yield* sleep(backoffDelay(tried, backoff))
          continue
        }

        if (tried > 1) {
          appendCauses(outcome, `policy:retry ${tried} attempts exhausted`)
        }

        return yield* outcome
      }

      const reply = outcome.value

      if (reply.kind === 'failure' && tried < attempts && when(reply.failure, false)) {
        yield* sleep(backoffDelay(tried, backoff))
        continue
      }

      return reply
    }
  },
})
