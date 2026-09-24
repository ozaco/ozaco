import { serializeError } from 'std:shared'

import type { Result } from '../types/result'

/**
 * Renders a Failure as one line: `<error>: <message>: <cause> > <cause>`. The error goes through
 * `serializeError` (an `Error` renders as `Name: message`, never `{}`); an empty message / cause
 * list drops its segment, and a message the rendered error already carries (an `Error` folded by
 * `asFailure` / `asFailureFrom`) is not repeated.
 */
export const formatFailure = (failure: Result.Failure<unknown>): string => {
  const { error, message } = failure
  const rendered = serializeError(error)

  const repeated =
    error instanceof Error
      ? error.message === message
      : typeof error === 'string' &&
        (rendered.endsWith(`: ${message}`) || rendered.includes(`: ${message} (`))

  const head = message && !repeated ? `${rendered}: ${message}` : rendered
  const causes = failure.causes.length > 0 ? `: ${failure.causes.join(' > ')}` : ''

  return `${head}${causes}`
}
