import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import type { CodecDef } from '../types/codec'

import { FAILURE_DEPTH, FAILURE_TAG, REVIVE_DEPTH, SCAN_BUDGET } from './const'

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * A failure as JSON data: `{ _t, error, message, causes }` — its nested failures encoded here, at
 * most {@link FAILURE_DEPTH} deep, a cause closing a cycle left out; `_d` and `raw` (the folded
 * foreign value) stay behind.
 */
const encodeFailure = (failure: Result.Failure<unknown>, path: Set<unknown>): CodecDef.Json => {
  path.add(failure)

  const causes: unknown[] = []

  for (const cause of Array.isArray(failure.causes) ? failure.causes : []) {
    if (typeof cause === 'string') {
      causes.push(cause)
    } else if (isFailure(cause) && !path.has(cause) && path.size < FAILURE_DEPTH) {
      causes.push(encodeFailure(cause, path))
    }
  }

  path.delete(failure)

  return { _t: FAILURE_TAG, error: failure.error, message: textOf(failure.message), causes }
}

function replacer(_key: string, value: unknown): unknown {
  if (isFailure(value)) {
    return encodeFailure(value, new Set())
  }

  return value
}

/**
 * Whether `value` holds a Failure anywhere JSON would write it — so the (much slower) replacer
 * only runs for values that need it. Past {@link SCAN_BUDGET} values it assumes so.
 */
const needsReplacer = (value: unknown): boolean => {
  let budget = SCAN_BUDGET

  const scan = (item: unknown): boolean => {
    if (typeof item !== 'object' || item === null) {
      return false
    }

    budget -= 1

    if (budget < 0 || isFailure(item)) {
      return true
    }

    if (ArrayBuffer.isView(item)) {
      return false
    }

    if (Array.isArray(item)) {
      return item.some(scan)
    }

    for (const key in item) {
      if (scan((item as CodecDef.Json)[key])) {
        return true
      }
    }

    return false
  }

  return scan(value)
}

/** A tagged failure rebuilt (its `error` and nested causes already are): a real Failure — string
 * and failure causes kept, anything else dropped. */
const decodeFailure = (data: CodecDef.Json): Result.Failure<unknown> =>
  fail(
    data.error,
    textOf(data.message),
    ...(Array.isArray(data.causes)
      ? data.causes.filter(cause => typeof cause === 'string' || isFailure(cause))
      : []),
  )

/** Set `key` as an own data property (a `__proto__` key stays a field, never the prototype). */
const define = (target: CodecDef.Json, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Parsed JSON with every tagged failure rebuilt, innermost first (a failure's causes are real
 * Failures before it is). Parsed data is fresh: it is rebuilt in place.
 */
export const revive = (value: unknown, depth = 0): unknown => {
  if (typeof value !== 'object' || value === null || depth > REVIVE_DEPTH) {
    return value
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      value[index] = revive(item, depth + 1)
    }

    return value
  }

  const data = value as CodecDef.Json

  for (const key of Object.keys(data)) {
    const item = data[key]
    const next = revive(item, depth + 1)

    if (next !== item) {
      define(data, key, next)
    }
  }

  return data._t === FAILURE_TAG ? decodeFailure(data) : data
}

/** `JSON.parse` rebuilding the failures {@link stringifyJson} tagged. Throws as `JSON.parse`
 * does. */
export const parseJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text)

  return text.includes(`"${FAILURE_TAG}"`) ? revive(value) : value
}

/** `JSON.stringify` writing a Failure (anywhere in `value`, through failure causes too) as tagged
 * data {@link parseJson} rebuilds. Throws as `JSON.stringify` does. */
export const stringifyJson = (value: unknown, space?: number): string =>
  needsReplacer(value) ? JSON.stringify(value, replacer, space) : JSON.stringify(value, null, space)
