// oxlint-disable import/exports-last
import type { ObserveDef, TraceDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail } from 'std:result'

import type { OtlpDef } from './types'

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

const nanos = (ms: number): string => `${Math.round(ms)}000000`

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

export const otlpSpan = (span: TraceDef.Span): Record<string, unknown> => ({
  traceId: traceIdOf(span.requestId),
  spanId: spanIdOf(span.spanId),
  ...(span.parentSpanId ? { parentSpanId: spanIdOf(span.parentSpanId) } : {}),
  name: span.name,
  kind: KINDS[span.kind] ?? 1,
  startTimeUnixNano: nanos(span.startedAt),
  endTimeUnixNano: nanos(span.endedAt),
  attributes: attributesOf({
    'ozaco.kind': span.kind,
    'ozaco.service_id': span.serviceId,
    'ozaco.instance': span.instance,
    'ozaco.action': span.actionId,
    'ozaco.transport': span.transport,
    ...span.attrs,
  }),
  status:
    span.status === 'failed'
      ? { code: 2, message: String(span.attrs?.['error'] ?? 'failed') }
      : span.status === 'cancelled'
        ? { code: 2, message: 'cancelled' }
        : { code: 1 },
})

const SEVERITY: Record<ObserveDef.Level, { number: number; text: string }> = {
  debug: { number: 5, text: 'DEBUG' },
  info: { number: 9, text: 'INFO' },
  warn: { number: 13, text: 'WARN' },
  error: { number: 17, text: 'ERROR' },
}

export const otlpLog = (row: ObserveDef.LogRow): Record<string, unknown> => ({
  timeUnixNano: nanos(row.ts),
  severityNumber: SEVERITY[row.level]?.number ?? 9,
  severityText: SEVERITY[row.level]?.text ?? 'INFO',
  body: { stringValue: row.msg },
  attributes: attributesOf(row.data),
  ...(row.requestId ? { traceId: traceIdOf(row.requestId) } : {}),
  ...(row.spanId ? { spanId: spanIdOf(row.spanId) } : {}),
})

export const otlpFailure = (row: ObserveDef.FailureRow): Record<string, unknown> => ({
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
})

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
