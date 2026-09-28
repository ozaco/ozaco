import type { Operation } from 'std:effect'

import { JsonCodec } from 'std:codec/impl/json'

import type { LoggerDef } from '../types/logger'

import { MOVED_PREFIX, TELEMETRY_BINDING, TELEMETRY_SENT, TRACE_KEYS } from './const'

/** The bindings as printed: without the `ozaco.telemetry = 'sent'` routing marker. */
export const visibleBindings = (bindings: Record<string, unknown>): Record<string, unknown> => {
  if (bindings[TELEMETRY_BINDING] !== TELEMETRY_SENT) {
    return bindings
  }

  const { [TELEMETRY_BINDING]: _marker, ...rest } = bindings

  return rest
}

/** W3C trace flags as the record carries them: two lowercase hex characters. */
export const flagsHex = (flags: number): string => (flags & 0xff).toString(16).padStart(2, '0')

/**
 * The entry as a flat JSON record: `level`, `time`, the message (`msgKey`), `trace_id` /
 * `span_id` / `trace_flags` (inside a span), the bindings (without the `ozaco.telemetry`
 * routing marker) and data fields, then the first failure's one-line form (`errorKey`). The
 * record's own keys always win: a binding or data key named like one of them (`level`, `time`,
 * `msgKey`, `errorKey`, `trace_id`, `span_id`, `trace_flags`) moves to `data.<key>`.
 */
export const toRecord = (
  entry: LoggerDef.Entry,
  msgKey = 'msg',
  errorKey = 'err',
): Record<string, unknown> => {
  // a Map, then `fromEntries`: insertion order is the JSON order and a `__proto__` key stays a field
  const record = new Map<string, unknown>([
    ['level', entry.level],
    ['time', entry.time],
    [msgKey, entry.msg],
  ])

  if (entry.trace) {
    record.set(TRACE_KEYS.traceId, entry.trace.traceId)
    record.set(TRACE_KEYS.spanId, entry.trace.spanId)
    record.set(TRACE_KEYS.flags, flagsHex(entry.trace.flags))
  }

  const reserved = new Set<string>([
    'level',
    'time',
    msgKey,
    errorKey,
    TRACE_KEYS.traceId,
    TRACE_KEYS.spanId,
    TRACE_KEYS.flags,
  ])

  const place = (fields: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(fields)) {
      record.set(reserved.has(key) ? `${MOVED_PREFIX}${key}` : key, value)
    }
  }

  place(visibleBindings(entry.bindings))

  if (entry.data) {
    place(entry.data)
  }

  if (entry.error) {
    record.set(errorKey, entry.error)
  }

  return Object.fromEntries(record)
}

export const toJson = (entry: LoggerDef.Entry, msgKey = 'msg', errorKey = 'err') =>
  JsonCodec.actions.stringify(toRecord(entry, msgKey, errorKey))

export const toNdjson = function* (
  entry: LoggerDef.Entry,
  msgKey = 'msg',
  errorKey = 'err',
): Operation<string> {
  return `${yield* toJson(entry, msgKey, errorKey)}\n`
}
