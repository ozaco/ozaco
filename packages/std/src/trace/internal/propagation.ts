import type { TraceDef } from '../types/trace'

import {
  HEX2,
  INVALID_SPAN_ID,
  INVALID_TRACE_ID,
  KNOWN_FLAGS,
  MAX_STATE_MEMBERS,
  SPAN_ID,
  STATE_KEY,
  STATE_VALUE,
  TRACE_ID,
} from './const'

/** HTTP optional whitespace (space / tab) around a field value or list member. */
const trimOws = (text: string): string => text.replaceAll(/^[\t ]+|[\t ]+$/gu, '')

/** The one value of a header: several `traceparent` fields make it invalid. */
const single = (value: string | readonly string[] | null | undefined): string | null => {
  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) && value.length === 1 && typeof value[0] === 'string'
    ? value[0]
    : null
}

/** Several `tracestate` fields are one list (RFC 9110 field order). */
const joined = (value: string | readonly string[] | null | undefined): string | null => {
  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) ? value.join(',') : null
}

/** A context that can be propagated / parented to: valid, non-zero ids. */
export const isValidContext = (context: TraceDef.SpanContext | null | undefined): boolean =>
  typeof context?.traceId === 'string' &&
  typeof context.spanId === 'string' &&
  TRACE_ID.test(context.traceId) &&
  SPAN_ID.test(context.spanId) &&
  context.traceId !== INVALID_TRACE_ID &&
  context.spanId !== INVALID_SPAN_ID

/**
 * Parse a W3C `traceparent` (trace-context level 2): lowercase hex, version `00` exactly 55 chars;
 * a higher version (not `ff`) parsed with the `00` layout when the char after the flags is `-` (or
 * the end); uppercase, all-zero ids, bad dashes ⇒ `null`. Only the sampled and random flag bits
 * are kept. Never throws; the result is `remote`.
 */
export const parseTraceparent = (value: unknown): TraceDef.SpanContext | null => {
  if (typeof value !== 'string') {
    return null
  }

  const text = trimOws(value)

  if (text.length < 55) {
    return null
  }

  const version = text.slice(0, 2)

  if (!HEX2.test(version) || version === 'ff' || text[2] !== '-') {
    return null
  }

  // version 00 is exactly `00-<32>-<16>-<2>`; a higher version may append `-<fields>`
  if (version === '00' ? text.length !== 55 : text.length > 55 && text[55] !== '-') {
    return null
  }

  const traceId = text.slice(3, 35)
  const spanId = text.slice(36, 52)
  const flags = text.slice(53, 55)

  if (
    !TRACE_ID.test(traceId) ||
    traceId === INVALID_TRACE_ID ||
    text[35] !== '-' ||
    !SPAN_ID.test(spanId) ||
    spanId === INVALID_SPAN_ID ||
    text[52] !== '-' ||
    !HEX2.test(flags)
  ) {
    return null
  }

  return { traceId, spanId, flags: Number.parseInt(flags, 16) & KNOWN_FLAGS, remote: true }
}

/** `00-<trace id>-<span id>-<flags>` — only the sampled / random flag bits go out. */
export const traceparentOf = (context: TraceDef.SpanContext): string =>
  `00-${context.traceId}-${context.spanId}-${(context.flags & KNOWN_FLAGS).toString(16).padStart(2, '0')}`

/**
 * Parse a W3C `tracestate` list into `[key, value]` members, in order: OWS trimmed, empty members
 * skipped. `null` when the list is invalid — a member breaking the key / value grammar, a
 * duplicate key, more than 32 members.
 */
export const parseTracestate = (value: unknown): [string, string][] | null => {
  if (typeof value !== 'string') {
    return null
  }

  const members: [string, string][] = []
  const keys = new Set<string>()

  for (const raw of value.split(',')) {
    const member = trimOws(raw)

    if (!member) {
      continue
    }

    const at = member.indexOf('=')

    if (at <= 0) {
      return null
    }

    const key = member.slice(0, at)
    const entry = member.slice(at + 1)

    if (!STATE_KEY.test(key) || !STATE_VALUE.test(entry) || keys.has(key)) {
      return null
    }

    keys.add(key)
    members.push([key, entry])
  }

  return members.length > MAX_STATE_MEMBERS ? null : members
}

/** Members back into a `tracestate` value (`,`-joined, no whitespace); `undefined` when empty. */
export const formatTracestate = (
  members: readonly (readonly [string, string])[],
): string | undefined =>
  members.length > 0 ? members.map(([key, value]) => `${key}=${value}`).join(',') : undefined

/**
 * `state` with `key=value` set as its LEFTMOST member (a modified key moves to the front, W3C);
 * the rightmost members give way past 32. An invalid key / value leaves `state` unchanged; an
 * invalid `state` is replaced by the one member.
 */
export const setTracestate = (
  state: string | undefined,
  key: string,
  value: string,
): string | undefined => {
  if (!STATE_KEY.test(key) || !STATE_VALUE.test(value)) {
    return state
  }

  const members = (state === undefined ? [] : (parseTracestate(state) ?? [])).filter(
    ([name]) => name !== key,
  )

  return formatTracestate([[key, value] as const, ...members].slice(0, MAX_STATE_MEMBERS))
}

/**
 * The inbound W3C context behind `source` (a getter — `name => headers.get(name)` — or a
 * carrier), or `null`: `traceparent`
 * per {@link parseTraceparent} (duplicate fields ⇒ invalid); `tracestate` only when that parsed —
 * several fields joined, validated, DROPPED (not the context) when invalid. Never throws.
 */
export const extract = (
  source: TraceDef.Getter | TraceDef.Carrier,
): TraceDef.SpanContext | null => {
  const get: TraceDef.Getter =
    typeof source === 'function' ? source : name => source[name as keyof TraceDef.Carrier]

  try {
    const parent = parseTraceparent(single(get('traceparent')))

    if (!parent) {
      return null
    }

    const raw = joined(get('tracestate'))
    const members = raw === null ? null : parseTracestate(raw)
    const state = members ? formatTracestate(members) : undefined
    const marked = members?.some(([key, value]) => key === 'ozaco' && value === '1') === true

    return { ...parent, ...(state ? { state } : {}), ...(marked ? { ozaco: true } : {}) }
  } catch {
    return null
  }
}
