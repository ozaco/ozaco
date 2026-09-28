import type { Result } from 'std:result'
import { asFailure, formatFailure, isFailure, isResult } from 'std:result'
import { isObject } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { LoggerDef } from '../types/logger'

import { ERROR_KEYS, NESTED_DEPTH } from './const'

/** A value that is a failure to log: a Failure as-is, an `Error` folded by `asFailure` (tagged
 * `std:result.unknown`, the `Error` kept as its `raw`). */
const failureOf = (value: unknown): Result.Failure<unknown> | undefined => {
  if (isFailure(value)) {
    return value
  }

  return value instanceof Error ? asFailure(value) : undefined
}

/** An object literal (the only objects searched for nested failures — class instances stay). */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isObject(value)) {
    return false
  }

  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

/** Set `key` as an own data property (a `__proto__` key stays a field, never the prototype). */
const define = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * `value` with every nested `Error` / Failure rendered by `formatFailure` (collected into
 * `failures`, payload order): never `{}` for an `Error`, never a Failure's internals. Copy on
 * write — the caller's objects are never mutated; a cycle and the levels past
 * {@link NESTED_DEPTH} stay as they are.
 */
const render = (value: unknown, depth: number, walk: Helpers.PayloadWalk): unknown => {
  const failure = failureOf(value)

  if (failure) {
    walk.failures.push(failure)

    return formatFailure(failure)
  }

  const { path } = walk

  if (depth > NESTED_DEPTH || typeof value !== 'object' || value === null || path.has(value)) {
    return value
  }

  if (Array.isArray(value)) {
    path.add(value)

    const items = value.map(item => render(item, depth + 1, walk))

    path.delete(value)

    return items.some((item, index) => item !== value[index]) ? items : value
  }

  if (!isPlainObject(value)) {
    return value
  }

  path.add(value)

  let changed = false
  const out: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value)) {
    const next = render(item, depth + 1, walk)

    changed ||= next !== item
    define(out, key, next)
  }

  path.delete(value)

  return changed ? out : value
}

/** JSON text that never throws (a bigint, a cycle): the value's string form instead. */
const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Split log call arguments into the entry's message, data and failures:
 * - strings join the message (space separated); an array is a VALUE joining it as JSON text;
 * - a Failure or an `Error` payload is a failure (an `Error` folded by `asFailure`); a success
 *   Result is unwrapped and normalized like its value;
 * - object payloads merge into `data` (later keys win). A top-level `Error` / Failure under the
 *   error key (`errorKey`, `err`, `error`) is lifted out as a failure; every other nested one
 *   stays in `data` rendered by `formatFailure` and is collected too.
 * `error` is the first failure's one-line form.
 */
export const normalizePayload = (
  args: readonly LoggerDef.Payload[],
  errorKey = 'err',
): Helpers.NormalizedPayload => {
  const failures: Result.Failure<unknown>[] = []
  const walk: Helpers.PayloadWalk = { failures, path: new WeakSet() }
  const messages: string[] = []
  let data: Record<string, unknown> | undefined

  for (const rawArg of args) {
    let arg: unknown = rawArg

    if (arg === undefined || arg === null) {
      continue
    }

    if (isResult(arg) && !isFailure(arg)) {
      arg = arg.value
    }

    const failure = failureOf(arg)

    if (failure) {
      // fully consumed — falling through would spread the failure's internals into `data`
      failures.push(failure)

      continue
    }

    if (typeof arg === 'string') {
      messages.push(arg)

      continue
    }

    if (Array.isArray(arg)) {
      // an array is a VALUE, not fields: it joins the message as JSON text rather than spreading
      // its indexes into `data` (plain data only — no codec needed for this)
      messages.push(jsonText(render(arg, 1, walk)))

      continue
    }

    if (!isObject(arg)) {
      continue
    }

    data ??= {}

    for (const [key, value] of Object.entries(arg)) {
      const lifted = key === errorKey || ERROR_KEYS.includes(key) ? failureOf(value) : undefined

      if (lifted) {
        failures.push(lifted)
        // a later payload's error key replaces an earlier field of the same name
        Reflect.deleteProperty(data, key)

        continue
      }

      define(data, key, render(value, 1, walk))
    }
  }

  const first = failures[0]

  return {
    msg: messages.join(' '),
    // an object payload that held nothing but its error is no data
    data: data && Object.keys(data).length > 0 ? data : undefined,
    error: first ? formatFailure(first) : '',
    failures,
  }
}
