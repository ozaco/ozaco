import { serializeError } from 'std:shared'

import type { Result } from '../types/result'

/** `<error>: <message>` — the message left out when empty or already carried by the error. */
const headOf = (failure: Result.Failure<unknown>): string => {
  const { error, message } = failure
  const rendered = serializeError(error)
  const repeated =
    typeof error === 'string' &&
    (rendered.endsWith(`: ${message}`) || rendered.includes(`: ${message} (`))

  return message && !repeated ? `${rendered}: ${message}` : rendered
}

/** A cause inline: a string as is, a nested failure as `(<error>: <message>)` — none when that
 * is the failure's own message already. */
const inlineOf = (cause: Result.Cause, message: string): string[] => {
  if (typeof cause === 'string') {
    return [cause]
  }

  const head = headOf(cause)

  return head === message ? [] : [`(${head})`]
}

/** The one-line rendering `formatFailure` gives without `{ chain: true }`:
 * `<error>: <message>: <cause> > <cause>`. */
export const oneLine = (failure: Result.Failure<unknown>): string => {
  const causes = failure.causes.flatMap(cause => inlineOf(cause, failure.message))

  return causes.length > 0 ? `${headOf(failure)}: ${causes.join(' > ')}` : headOf(failure)
}
