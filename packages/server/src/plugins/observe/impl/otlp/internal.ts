// oxlint-disable import/exports-last
import type { ObserveDef, TraceDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers, OtlpDef } from './types'

/** OTLP ids are hex: a UUID request id (32 hex) is the trace id; anything else is hashed. */
const HEX = /^[0-9a-f]+$/u

const fnv = (text: string, width: number): string => {
  let hash = 0x81_1c_9d_c5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0
  }

  let out = hash.toString(16).padStart(8, '0')

  while (out.length < width) {
    hash = Math.imul(hash ^ 0x9e_37_79_b9, 0x01_00_01_93) >>> 0
    out += hash.toString(16).padStart(8, '0')
  }

  return out.slice(0, width)
}

const traceIdOf = (requestId: string): string => {
  const bare = requestId.replaceAll('-', '').toLowerCase()
  return bare.length === 32 && HEX.test(bare) ? bare : fnv(requestId, 32)
}

const spanIdOf = (spanId: string): string => {
  const bare = spanId.toLowerCase()
  return bare.length === 16 && HEX.test(bare) ? bare : fnv(spanId, 16)
}

export const nanos = (ms: number): string => `${Math.round(ms)}000000`

/** `abc_def` → `abcDef`; leading underscores survive (`_created_at` → `_createdAt`). */
const camelKey = (key: string): string => {
  const prefix = /^_+/u.exec(key)?.[0] ?? ''

  return (
    prefix +
    key.slice(prefix.length).replaceAll(/_+([a-z0-9])/gu, (_, ch: string) => ch.toUpperCase())
  )
}

/** EVERYTHING bound for OTLP passes through this: the payload is a camelCase world, so every
 * plain object's keys — however deeply nested (rows, attrs, log data, causes…) — are renamed
 * recursively; values and non-plain objects pass through untouched. */
export const toCamelDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(toCamelDeep)
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    (value.constructor === Object || Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [camelKey(key), toCamelDeep(entry)]),
    )
  }

  return value
}

const valueOf = (value: unknown): OtlpDef.AnyValue => {
  if (typeof value === 'boolean') {
    return { boolValue: value }
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }

  if (typeof value === 'string') {
    return { stringValue: value }
  }

  return { stringValue: JSON.stringify(value) ?? 'undefined' }
}

export const attributesOf = (
  record: Readonly<Record<string, unknown>> | null | undefined,
): OtlpDef.KeyValue[] =>
  Object.entries(record ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: valueOf(value) }))

/** OTLP SpanKind: SERVER for edge/dispatch roots, CLIENT for carrier sends, INTERNAL otherwise. */
const KINDS: Record<string, number> = {
  edge: 2,
  dispatch: 2,
  carrier: 3,
  call: 3,
  cache: 1,
  db: 1,
}

export const otlpSpan = (raw: TraceDef.Span): Record<string, unknown> => {
  const span = toCamelDeep(raw) as AnyType

  return {
    traceId: traceIdOf(span.requestId),
    spanId: spanIdOf(span.spanId),
    ...(span.parentSpanId ? { parentSpanId: spanIdOf(span.parentSpanId) } : {}),
    name: span.name,
    kind: KINDS[span.kind] ?? 1,
    startTimeUnixNano: nanos(span.startedAt),
    endTimeUnixNano: nanos(span.endedAt),
    attributes: attributesOf({
      // the OTLP payload is a camelCase world (protocol keys are camel) — our attr leaves match
      'ozaco.kind': span.kind,
      'ozaco.serviceId': span.serviceId,
      'ozaco.instance': span.instance,
      'ozaco.action': span.actionId,
      'ozaco.transport': span.transport,
      ...span.attrs,
    }),
    status:
      span.status === 'failed'
        ? {
            code: 2,
            message: String(span.attrs?.['error.message'] || span.attrs?.['error'] || 'failed'),
          }
        : span.status === 'cancelled'
          ? { code: 2, message: 'cancelled' }
          : { code: 1 },
  }
}

/** OTLP SpanKind for an observed event: a frame we RECEIVED is CONSUMER, one we SENT (or an
 * emitted event) is PRODUCER, everything else INTERNAL. */
const EVENT_KINDS: Record<string, number> = {
  'socket-in': 5,
  'socket-out': 4,
  emit: 4,
}

/** The console reads inbound frames as `→ in` and outbound as `← out` — the trace says the same. */
const eventSpanName = (row: ObserveDef.EventRow): string =>
  row.kind === 'socket-in'
    ? `WS → ${row.name}`
    : row.kind === 'socket-out'
      ? `WS ← ${row.name}`
      : `${row.kind} ${row.name}`

/**
 * An observed event as a POINT-IN-TIME span (`ts` to `ts`) under the span it happened in — the
 * socket SESSION span for WS frames, the emitting dispatch for `emit`. Without this a chatty
 * socket is invisible in the trace: its frames are events, and only spans reach `v1/traces`.
 *
 * `seq` disambiguates events that share a millisecond (span ids must be unique per trace).
 */
export const otlpEventSpan = (
  row: ObserveDef.EventRow,
  seq: number,
  withData: boolean,
): Record<string, unknown> => {
  const at = nanos(row.ts)

  return {
    traceId: traceIdOf(row.request_id ?? ''),
    spanId: fnv(`${row.request_id}|${row.span_id}|${row.kind}|${row.ts}|${seq}`, 16),
    ...(row.span_id ? { parentSpanId: spanIdOf(row.span_id) } : {}),
    name: eventSpanName(row),
    kind: EVENT_KINDS[row.kind] ?? 1,
    startTimeUnixNano: at,
    endTimeUnixNano: at,
    attributes: attributesOf({
      'ozaco.kind': 'event',
      'ozaco.event': row.kind,
      'ozaco.name': row.name,
      'ozaco.size': row.size,
      ...(withData ? { 'ozaco.data': row.data } : {}),
    }),
    status: { code: 1 },
  }
}

const SEVERITY: Record<ObserveDef.Level, { number: number; text: string }> = {
  debug: { number: 5, text: 'DEBUG' },
  info: { number: 9, text: 'INFO' },
  warn: { number: 13, text: 'WARN' },
  error: { number: 17, text: 'ERROR' },
}

export const otlpLog = (raw: ObserveDef.LogRow): Record<string, unknown> => {
  const row = toCamelDeep(raw) as AnyType

  return {
    timeUnixNano: nanos(row.ts),
    severityNumber: SEVERITY[row.level as ObserveDef.Level]?.number ?? 9,
    severityText: SEVERITY[row.level as ObserveDef.Level]?.text ?? 'INFO',
    body: { stringValue: row.msg },
    attributes: attributesOf(row.data),
    ...(row.requestId ? { traceId: traceIdOf(row.requestId) } : {}),
    ...(row.spanId ? { spanId: spanIdOf(row.spanId) } : {}),
  }
}

export const otlpFailure = (raw: ObserveDef.FailureRow): Record<string, unknown> => {
  const row = toCamelDeep(raw) as AnyType

  return {
    timeUnixNano: nanos(row.ts),
    severityNumber: 17,
    severityText: 'ERROR',
    body: { stringValue: row.message || row.tag },
    attributes: attributesOf({
      'exception.type': row.tag,
      'exception.message': row.message,
      'ozaco.causes': row.causes,
      'ozaco.where': row.where,
      'http.status': row.status,
    }),
    ...(row.requestId ? { traceId: traceIdOf(row.requestId) } : {}),
    ...(row.spanId ? { spanId: spanIdOf(row.spanId) } : {}),
  }
}

/** Default latency buckets (ms) of the request duration histogram. */
export const DEFAULT_BUCKETS: readonly number[] = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000,
]

export const createOtlpMetrics = (buckets: readonly number[]): Helpers.OtlpMetrics => {
  const requests = new Map<string, Helpers.Counter>()
  const durations = new Map<string, Helpers.Histogram>()
  const failures = new Map<string, Helpers.Counter>()

  const counter = (
    map: Map<string, Helpers.Counter>,
    key: string,
    attrs: Record<string, unknown>,
  ) => {
    const existing = map.get(key)

    if (existing) {
      existing.count += 1
      return
    }

    map.set(key, { attributes: attributesOf(attrs), count: 1 })
  }

  const sums = (map: Map<string, Helpers.Counter>, startNano: string, nowNano: string) =>
    [...map.values()].map(entry => ({
      attributes: entry.attributes,
      startTimeUnixNano: startNano,
      timeUnixNano: nowNano,
      asInt: String(entry.count),
    }))

  return {
    record: raw => {
      const span = toCamelDeep(raw) as AnyType

      if (span.kind !== 'edge' && span.kind !== 'dispatch') {
        return
      }

      const key = `${span.kind}|${span.name}|${span.status}`
      const attrs = {
        'ozaco.kind': span.kind,
        'ozaco.action': span.name,
        'ozaco.status': span.status,
      }
      counter(requests, key, attrs)

      const duration = Math.max(0, span.endedAt - span.startedAt)
      const dKey = `${span.kind}|${span.name}`
      let histogram = durations.get(dKey)

      if (!histogram) {
        histogram = {
          attributes: attributesOf({ 'ozaco.kind': span.kind, 'ozaco.action': span.name }),
          bucketCounts: Array.from({ length: buckets.length + 1 }, () => 0),
          count: 0,
          sum: 0,
        }
        durations.set(dKey, histogram)
      }

      const slot = buckets.findIndex(bound => duration <= bound)
      const index = slot === -1 ? buckets.length : slot
      histogram.bucketCounts[index] = (histogram.bucketCounts[index] ?? 0) + 1
      histogram.count += 1
      histogram.sum += duration
    },
    failure: row => {
      counter(failures, row.tag, { 'ozaco.tag': row.tag, 'ozaco.where': row.where })
    },
    snapshot: (startNano, nowNano) => {
      const metrics: Record<string, unknown>[] = []

      if (requests.size > 0) {
        metrics.push({
          name: 'ozaco.requests',
          unit: '1',
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: sums(requests, startNano, nowNano),
          },
        })
      }

      if (durations.size > 0) {
        metrics.push({
          name: 'ozaco.request.duration',
          unit: 'ms',
          histogram: {
            aggregationTemporality: 2,
            dataPoints: [...durations.values()].map(entry => ({
              attributes: entry.attributes,
              startTimeUnixNano: startNano,
              timeUnixNano: nowNano,
              count: String(entry.count),
              sum: entry.sum,
              bucketCounts: entry.bucketCounts.map(String),
              explicitBounds: [...buckets],
            })),
          },
        })
      }

      if (failures.size > 0) {
        metrics.push({
          name: 'ozaco.failures',
          unit: '1',
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: sums(failures, startNano, nowNano),
          },
        })
      }

      return metrics
    },
  }
}

/** POST one OTLP/JSON payload; a non-2xx answer fails `server.unavailable`. */
export function* post(target: OtlpDef.Target, payload: unknown): Operation<void> {
  let response: Response

  try {
    response = yield* until(
      target.fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...target.headers },
        body: JSON.stringify(payload),
      }),
    )
  } catch (error) {
    return yield* fail(ServerErrors.Unavailable, `otlp: ${String(error)}`)
  }

  if (!response.ok) {
    return yield* fail(ServerErrors.Unavailable, `otlp: ${response.status} from ${target.url}`)
  }
}
