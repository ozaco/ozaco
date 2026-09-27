import { asFailure } from 'std:result'

/** A breaker's open reason as the detail of its `circuit open (…)` message: the failure's message
 * (a foreign value folded by `asFailure` first), else its tag. */
export const describe = (reason: unknown): string => {
  if (reason === undefined) {
    return ''
  }

  const failure = asFailure(reason)

  return failure.message || String(failure.error)
}
