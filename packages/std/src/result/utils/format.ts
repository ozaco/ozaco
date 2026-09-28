import { oneLine } from '../internal/format'
import { renderChain } from '../internal/render'
import type { ResultDef } from '../types/def'
import type { Result } from '../types/result'

/**
 * Renders a Failure as one line: `<error>: <message>: <cause> > <cause>`. The error goes through
 * `serializeError`; an empty message / cause list drops its segment, and a message the rendered
 * error already carries is not repeated. A nested failure cause renders inline as
 * `(<error>: <message>)` (left out when that text is the failure's message already).
 *
 * With `{ chain: true }` it renders the whole chain Java style, one level per failure, depth
 * first: `<error>: <message>`, a `    at <cause>` line per string cause (stored order), then every
 * failure it wraps as a `Caused by: <error>: <message>` level of its own — every level and every
 * cause, nothing cut (each failure once, so a cycle ends).
 */
export const formatFailure = (
  failure: Result.Failure<unknown>,
  options: ResultDef.FormatOptions = {},
): string => (options.chain ? renderChain(failure) : oneLine(failure))
