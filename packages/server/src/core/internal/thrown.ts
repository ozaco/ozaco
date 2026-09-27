import type { Result } from 'std:result'
import { ResultErrors } from 'std:result'

/**
 * Whether `failure` stands for a thrown non-Result value: `asFailure`'s fold of a foreign throw
 * (`std:result.unknown`), or a failure carrying no tag in its `error` slot (a hand-built
 * `fail(value)`). The kernel answers both as `server.internal`.
 */
export const isThrown = (failure: Result.Failure<unknown>): boolean =>
  typeof failure.error !== 'string' || failure.error === ResultErrors.Unknown
