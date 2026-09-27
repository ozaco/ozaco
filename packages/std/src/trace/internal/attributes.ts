import { formatFailure, isFailure } from 'std:result'
import { serializeError } from 'std:shared'

import type { TraceDef } from '../types/trace'

import { FLATTEN_DEPTH } from './const'

const ELLIPSIS = '…'
const ELLIPSIS_BYTES = 3

/** The UTF-8 size of one code point (a lone surrogate encodes as U+FFFD: 3 bytes). */
const pointBytes = (point: number): number =>
  point < 0x80 ? 1 : point < 0x8_00 ? 2 : point < 0x1_00_00 ? 3 : 4

/** An object literal (never a Failure — that renders as its one-line form). */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || isFailure(value)) {
    return false
  }

  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A number every sink carries alike: a non-finite one (`NaN`, `±Infinity`) becomes its STRING
 * (`'NaN'`, `'Infinity'`, `'-Infinity'`) — JSON has no form for it (`null`), protobuf keeps the
 * double, a store column may refuse it, so left a number each sink would hold something else.
 * `-0` becomes `0` for the same reason (JSON writes it `0`, protobuf keeps the sign).
 */
const portableNumber = (value: number): number | string => {
  if (!Number.isFinite(value)) {
    return String(value)
  }

  return value === 0 ? 0 : value
}

/** An `Error` / Failure as one readable line, a bigint as its digits, a non-finite number as its
 * string ({@link portableNumber}); anything else as-is. */
const readable = (value: unknown): unknown => {
  if (typeof value === 'number') {
    return portableNumber(value)
  }

  if (isFailure(value)) {
    return formatFailure(value)
  }

  if (value instanceof Error) {
    return serializeError(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  return value
}

const normalizeArray = (items: readonly unknown[], maxBytes: number): TraceDef.AttrValue => {
  if (items.every(item => typeof item === 'string')) {
    return (items as readonly string[]).map(item => capBytes(item, maxBytes))
  }

  if (items.every(item => typeof item === 'number')) {
    const numbers = items as readonly number[]

    // one non-finite number turns the array into strings: it stays homogeneous
    return numbers.every(item => Number.isFinite(item))
      ? numbers.map(item => (item === 0 ? 0 : item))
      : numbers.map(String)
  }

  if (items.every(item => typeof item === 'boolean')) {
    return [...(items as readonly boolean[])]
  }

  // an array holding objects has no flat form: it travels as one (capped) JSON string
  if (items.some(item => typeof item === 'object' && item !== null)) {
    return capBytes(safeJson(items), maxBytes)
  }

  // mixed primitives: a homogeneous string array
  return items.map(item => capBytes(String(readable(item)), maxBytes))
}

/** The UTF-8 byte length of `text`, without encoding it. */
export const byteLength = (text: string): number => {
  let bytes = 0

  for (const char of text) {
    bytes += pointBytes(char.codePointAt(0) ?? 0)
  }

  return bytes
}

/** `text` cut on a code-point boundary to at most `max` UTF-8 bytes, a cut marked with `…`. */
export const capBytes = (text: string, max: number): string => {
  // every UTF-16 unit encodes to at most 3 bytes: short strings never need the exact count
  if (text.length * 3 <= max || byteLength(text) <= max) {
    return text
  }

  if (max < ELLIPSIS_BYTES) {
    return ''
  }

  const budget = max - ELLIPSIS_BYTES
  let bytes = 0
  let cut = ''

  for (const char of text) {
    const size = pointBytes(char.codePointAt(0) ?? 0)
    if (bytes + size > budget) {
      break
    }
    bytes += size
    cut += char
  }

  return `${cut}${ELLIPSIS}`
}

/** JSON of `value` that never throws: cycles become `[Circular]`, bigints strings, Errors lines,
 * non-finite numbers their strings (`"NaN"`, never `null`). */
export const safeJson = (value: unknown): string => {
  const seen = new WeakSet<object>()

  try {
    const text = JSON.stringify(value, (_key, raw: unknown) => {
      const item = readable(raw)
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) {
          return '[Circular]'
        }
        seen.add(item)
      }
      return item
    })

    return text ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/** One attribute value in its stored form; `undefined` when it carries nothing. */
export const normalizeValue = (
  value: unknown,
  maxBytes: number,
): TraceDef.AttrValue | undefined => {
  switch (typeof value) {
    case 'string': {
      return capBytes(value, maxBytes)
    }
    case 'number': {
      return portableNumber(value)
    }
    case 'boolean': {
      return value
    }
    case 'bigint': {
      return value.toString()
    }
    case 'symbol': {
      return capBytes(value.toString(), maxBytes)
    }
    case 'undefined':
    case 'function': {
      return undefined
    }
    default: {
      break
    }
  }

  if (value === null) {
    return undefined
  }

  if (Array.isArray(value)) {
    return normalizeArray(value, maxBytes)
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }

  const item = readable(value)

  return capBytes(typeof item === 'string' ? item : safeJson(item), maxBytes)
}

/**
 * `input` as stored `[key, value]` pairs: `null` / `undefined` dropped, plain objects flattened to
 * dotted keys ({@link FLATTEN_DEPTH} levels, deeper ones a capped JSON string), strings capped to
 * `maxBytes` UTF-8 bytes, non-finite numbers their strings (`'NaN'`, `'Infinity'`, `'-Infinity'`
 * — a number array holding one becomes a string array). Keys are never transformed; an empty key
 * is dropped.
 */
export const entriesOf = (
  input: TraceDef.AttributesInput | undefined,
  maxBytes: number,
): [string, TraceDef.AttrValue][] => {
  const out: [string, TraceDef.AttrValue][] = []

  const visit = (key: string, value: unknown, depth: number): void => {
    if (!isPlainObject(value)) {
      const normalized = normalizeValue(value, maxBytes)
      if (normalized !== undefined) {
        out.push([key, normalized])
      }
      return
    }

    if (depth >= FLATTEN_DEPTH) {
      out.push([key, capBytes(safeJson(value), maxBytes)])
      return
    }

    for (const [inner, nested] of Object.entries(value)) {
      visit(`${key}.${inner}`, nested, depth + 1)
    }
  }

  const source = (input ?? {}) as Record<string, unknown>

  for (const key of Object.keys(source)) {
    if (!key) {
      continue
    }
    // a getter that throws (here or nested) drops its attribute, never the span code's call
    try {
      visit(key, source[key], 0)
    } catch {
      continue
    }
  }

  return out
}

/** `input` normalized under a value cap and a count cap (the rest counted as dropped). */
export const attributesOf = (
  input: TraceDef.AttributesInput | undefined,
  maxBytes: number,
  maxCount: number,
): { attributes: TraceDef.Attributes; dropped: number } => {
  // a Map, then `fromEntries`: a key such as `__proto__` stays an own property
  const attributes = new Map<string, TraceDef.AttrValue>()
  let dropped = 0

  for (const [key, value] of entriesOf(input, maxBytes)) {
    if (attributes.has(key) || attributes.size < maxCount) {
      attributes.set(key, value)
    } else {
      dropped += 1
    }
  }

  return { attributes: Object.fromEntries(attributes), dropped }
}
