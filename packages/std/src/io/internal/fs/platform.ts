import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { asFailure } from 'std:result'

import { IOErrors } from '../../errors'

/**
 * A platform filesystem call awaited — its rejection folded through the `IOErrors` matchers
 * (`ENOENT` → `std:io.not-found`, `EEXIST` → `std:io.exists`, `EACCES` / `EPERM` →
 * `std:io.access-denied`; anything else `std:result.unknown`), the platform error kept as `raw`.
 */
export function* fsCall<T>(promise: Promise<T>): Operation<T> {
  try {
    return yield* until(promise)
  } catch (error) {
    return yield* asFailure(error, IOErrors)
  }
}
