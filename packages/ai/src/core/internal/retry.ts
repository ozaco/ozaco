import type { Operation } from 'std:effect'
import { attempt, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { isSuccess } from 'std:result'

import { RETRY_AFTER_CAUSE, RETRY_BASE_DELAY_MS } from '../const'
import { AiErrors } from '../errors'

/** Extract the provider's retry-after hint (in ms) from a failure's `retry-after:<seconds>`
 * cause, or `undefined` when it carries none. */
export const retryAfterMs = (failure: Result.Failure<unknown>): number | undefined => {
  for (const cause of failure.causes) {
    if (typeof cause === 'string' && cause.startsWith(`${RETRY_AFTER_CAUSE}:`)) {
      const seconds = Number(cause.slice(RETRY_AFTER_CAUSE.length + 1))
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000
      }
    }
  }
  return undefined
}

/** Run `body`, retrying `ai.rate-limit` failures up to `retries` times — honoring the provider's
 * retry-after hint, else backing off exponentially from {@link RETRY_BASE_DELAY_MS}. Any other
 * failure (and an exhausted budget) re-raises untouched. */
export function* withRetry<T>(retries: number, body: () => Operation<T>): Operation<T> {
  for (let round = 0; ; round += 1) {
    const outcome = (yield* attempt(body())) as Result<T, unknown>
    if (isSuccess(outcome)) {
      return outcome.value
    }
    if (round >= retries || outcome.error !== AiErrors.RateLimit) {
      return yield* outcome
    }
    yield* sleep(retryAfterMs(outcome) ?? RETRY_BASE_DELAY_MS * 2 ** round)
  }
}
