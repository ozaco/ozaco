import type { AnyType, Helpers } from 'std:shared'
import { serializeError } from 'std:shared'

import { RESULT_FAILURE } from '../const'
import { ResultErrors } from '../errors'
import type { Result } from '../types/result'
import { isFailure, isSuccess } from '../utils/is'

import { matchOf } from './match'

/**
 * One value given as a cause, normalized: a string stays, a Failure (a failed Result) is the SAME
 * object, a Success / `null` / `undefined` is nothing. Anything else is not a cause — it is
 * folded as `asFailure` folds it (the safety net for an untyped caller).
 */
const causeOf = (value: unknown): Result.Cause | undefined => {
  if (typeof value === 'string' || isFailure(value)) {
    return value
  }

  if (value === undefined || value === null || isSuccess(value)) {
    return undefined
  }

  return foldOf(value)
}

/** The failure object — every field the type declares is present (`error` undefined for the
 * bare `fail()`); `raw` only on a fold of a foreign value. */
export const createFailure = (
  error: unknown,
  message: string,
  causes: Result.Cause[],
  ...raw: [] | [unknown]
): Result.Failure<AnyType> =>
  ({
    _t: RESULT_FAILURE,
    _d: Date.now(),
    error,
    message,
    causes,
    ...(raw.length > 0 ? { raw: raw[0] } : {}),

    *[Symbol.iterator]() {
      // oxlint-disable-next-line no-this-alias
      const self = this

      yield self
    },
  }) as Result.Failure<AnyType>

/**
 * A value as a Failure (what `asFailure` does before appending causes): a Failure is itself —
 * unless it is a `std:result.unknown` fold and `tags` recognizes its `raw`, then it is that tag's
 * failure (its causes and `raw` kept); a foreign value is folded, kept as `raw`, into the tag
 * `tags` recognizes it as (the message its matcher named, else its own `message`, else `code`)
 * or into `std:result.unknown` (its `serializeError` text the message).
 */
export const foldOf = (value: unknown, tags?: Helpers.TagMatchers): Result.Failure<unknown> => {
  if (isFailure(value)) {
    if (!tags || value.error !== ResultErrors.Unknown || !('raw' in value)) {
      return value
    }

    const match = matchOf(value.raw, tags, () => value.message)

    return match === undefined
      ? value
      : createFailure(match.tag, match.message, [...value.causes], value.raw)
  }

  const match = tags ? matchOf(value, tags, () => serializeError(value)) : undefined

  return match === undefined
    ? createFailure(ResultErrors.Unknown, serializeError(value), [], value)
    : createFailure(match.tag, match.message, [], value)
}

/** `values` as causes of `owner` (see {@link causeOf}); `owner` itself is never its own cause. */
export const causesOf = (
  values: readonly unknown[],
  owner?: Result.Failure<unknown>,
): Result.Cause[] => {
  const causes: Result.Cause[] = []

  for (const value of values) {
    const cause = causeOf(value)

    if (cause !== undefined && cause !== owner) {
      causes.push(cause)
    }
  }

  return causes
}
