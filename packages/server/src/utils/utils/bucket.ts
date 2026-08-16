import { fail } from 'std:result'

import type { TokenBucket, TokenBucketOptions } from '../types'

/**
 * Create a {@link TokenBucket} that starts full and refills continuously — the refill is computed
 * lazily from the time elapsed since the last interaction, so no timer runs in the background.
 * Inject `now` for deterministic tests.
 *
 * @throws an `invalid-options` failure when `capacity` is not a positive finite number or
 * `refillPerSecond` is negative — invalid configuration is a programmer error, not a runtime
 * failure.
 */
export const createTokenBucket = (options: TokenBucketOptions): TokenBucket => {
  const { capacity, refillPerSecond } = options

  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw fail(
      'invalid-options',
      `createTokenBucket: capacity must be a positive number, got ${capacity}`,
    )
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond < 0) {
    throw fail(
      'invalid-options',
      `createTokenBucket: refillPerSecond must be zero or positive, got ${refillPerSecond}`,
    )
  }

  const now = options.now ?? Date.now
  let tokens = capacity
  let updatedAt = now()

  const refill = () => {
    const current = now()
    if (current > updatedAt) {
      tokens = Math.min(capacity, tokens + ((current - updatedAt) / 1000) * refillPerSecond)
    }
    updatedAt = current
  }

  return {
    take(count = 1) {
      refill()
      if (count > tokens) {
        return false
      }
      tokens -= count
      return true
    },
    available() {
      refill()
      return tokens
    },
  }
}
