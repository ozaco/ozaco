import type { Result } from 'std:result'

import { CoreStatusMap } from '../const'

/** Resolves a failure's HTTP status: action `errors` map → core map → 500. */
export const statusFor = (
  failure: Result.Failure<unknown>,
  errors?: Record<string, number>,
): number => {
  const tag = String(failure.error)

  return errors?.[tag] ?? CoreStatusMap[tag] ?? 500
}
