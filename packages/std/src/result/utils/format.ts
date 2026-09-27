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
 * failure it wraps as a `Caused by: <error>: <message>` level of its own (at most 8 deep, each
 * failure once). `maxBytes` is a UTF-8 budget (default 16384): every header is kept first (its
 * error and message cut to 200 bytes under an explicit budget, 4096 without; middle levels, then
 * the outermost, give way before the innermost one), the `at` lines fill the rest innermost level
 * first, the elided ones counted by `    ... N more`.
 */
export const formatFailure = (
  failure: Result.Failure<unknown>,
  options: ResultDef.FormatOptions = {},
): string => (options.chain ? renderChain(failure, options) : oneLine(failure))
