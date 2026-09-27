import type { Result } from 'std:result'
import { formatFailure } from 'std:result'

import { capBytes } from '../internal/attributes'
import { chainOf } from '../internal/chain'
import { LOG_VALUE_BYTES, MAX_VALUE_BYTES } from '../internal/const'
import { levelType } from '../internal/exception'
import type { TraceDef } from '../types/trace'

/** `exception.type`: the failure's tag (a non-string error as its `serializeError` text). */
export const exceptionType = (failure: Result.Failure<unknown>): string => levelType(failure)

/**
 * The failure's cause chain as `exception.stacktrace` text: `formatFailure(f, { chain: true })`
 * under a UTF-8 budget (default 16384) — every level's header is reserved first and the
 * innermost `Caused by:` header is never dropped, the `at` lines fill the rest innermost first.
 */
export const renderFailure = (
  failure: Result.Failure<unknown>,
  options: TraceDef.RenderOptions = {},
): string => formatFailure(failure, { chain: true, maxBytes: options.maxBytes ?? LOG_VALUE_BYTES })

/**
 * `ozaco.failure.chain`: `<type>: <message>` per failure, the failure first, then every failure
 * nested in its causes depth first (at most 8 deep, 32 in all) — each ≤ 2048 bytes.
 */
export const failureChain = (failure: Result.Failure<unknown>): string[] =>
  chainOf(failure).map(level => {
    const type = levelType(level)

    return capBytes(level.message ? `${type}: ${level.message}` : type, MAX_VALUE_BYTES)
  })

/**
 * The attributes of an `exception` span event / exception log record: `exception.type`,
 * `exception.message`, `exception.stacktrace` (the budgeted chain rendering), `ozaco.failure.chain`
 * (ALWAYS, even for one level) and `ozaco.failure.causes` (the failure's own string causes — left
 * out when it has none: an empty array is no value every sink keeps). No `error.type` — that lives
 * on the span.
 */
export const exceptionAttributes = (
  failure: Result.Failure<unknown>,
  options: TraceDef.RenderOptions = {},
): TraceDef.Attributes => {
  const type = exceptionType(failure)
  const message = failure.message || type
  const causes = failure.causes.filter((cause): cause is string => typeof cause === 'string')

  return {
    'exception.type': capBytes(type, MAX_VALUE_BYTES),
    'exception.message': capBytes(message, MAX_VALUE_BYTES),
    'exception.stacktrace': renderFailure(failure, options),
    'ozaco.failure.chain': failureChain(failure),
    ...(causes.length > 0
      ? { 'ozaco.failure.causes': causes.map(cause => capBytes(cause, MAX_VALUE_BYTES)) }
      : {}),
  }
}
