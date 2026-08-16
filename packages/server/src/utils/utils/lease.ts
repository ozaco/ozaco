import type { Operation } from 'std:effect'
import { sleep } from 'std:effect'
import { fail } from 'std:result'

import type { Lease, LeaseOptions } from '../types'

const MIN_INTERVAL_MS = 10

/**
 * Create a deterministic {@link Lease}: it expires `ttlMs` after creation unless `renew()` pushes
 * the deadline forward. Inject `now` for deterministic tests.
 *
 * @throws an `invalid-options` failure when `ttlMs` is not a positive finite number — invalid
 * configuration is a programmer error, not a runtime failure.
 */
export const createLease = (options: LeaseOptions): Lease => {
  const { ttlMs } = options

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw fail('invalid-options', `createLease: ttlMs must be a positive number, got ${ttlMs}`)
  }

  const now = options.now ?? Date.now
  let deadline = now() + ttlMs

  return {
    ttlMs,
    renew() {
      deadline = now() + ttlMs
    },
    expired() {
      return now() >= deadline
    },
    remaining() {
      return Math.max(0, deadline - now())
    },
  }
}

/**
 * Watch a lease and run `onExpire` ONCE when it lapses, then return. Polls every `intervalMs`
 * (default `ttlMs / 4`, minimum 10ms). Run it under `fork`/`spawn` — it blocks until the lease
 * expires.
 */
export function* guardLease(
  lease: Lease,
  onExpire: () => Operation<void>,
  options: { intervalMs?: number } = {},
): Operation<void> {
  const intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? lease.ttlMs / 4)

  while (!lease.expired()) {
    yield* sleep(intervalMs)
  }

  yield* onExpire()
}
