import type { Operation } from 'std:effect'
import { attempt, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import type { Singleflight } from '../types'

/**
 * Create a {@link Singleflight}: concurrent `run` calls with the same key share ONE execution.
 * The first caller runs `op` via `attempt` and settles a shared future; joiners wait on it and
 * receive the same Result — failures re-raise in every joiner. The entry is removed after the
 * outcome settles, so later calls start a fresh execution. A leader halted before settling rejects
 * the shared future so joiners fail loudly instead of hanging.
 */
export const createSingleflight = <T = unknown>(): Singleflight<T> => {
  const inflight = new Map<string, Operation<Result<T, unknown>>>()

  return {
    *run(key, op) {
      const pending = inflight.get(key)
      if (pending !== undefined) {
        const shared = yield* pending
        if (isFailure(shared)) {
          return yield* shared
        }
        return shared.value
      }

      const future = withResolvers<Result<T, unknown>>(`singleflight(${key})`)
      inflight.set(key, future.operation)

      try {
        const result = yield* attempt(op)
        future.resolve(result)
        if (isFailure(result)) {
          return yield* result
        }
        return result.value
      } finally {
        inflight.delete(key)
        // idempotent: withResolvers keeps the first settlement, so this only takes effect when the
        // leader was halted before resolving — joiners then raise instead of suspending forever
        future.reject(
          fail('singleflight-halted', `singleflight("${key}") leader halted before settling`),
        )
      }
    },

    size: () => inflight.size,
  }
}
