import type { TracerDef } from 'server:core'

import { STATUS_DESCRIPTION_ATTRIBUTE } from '../const'

import type { Otlp } from './types'

const SPAN_KINDS: Record<TracerDef.SpanKind, number> = { internal: 1, server: 2, client: 3 }

const STATUS_CODE_OK = 1
const STATUS_CODE_ERROR = 2

/** The instrumentation scope every batch is attributed to. */
const OTLP_SCOPE_NAME = 'ozaco-server'

/** Protobuf-JSON: 64-bit nanos are decimal strings — BigInt keeps `ms * 1e6` exact. */
const nanosOf = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString()

const anyValueOf = (value: string | number | boolean): Otlp.AnyValue => {
  if (typeof value === 'boolean') {
    return { boolValue: value }
  }

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }

  return { stringValue: value }
}

const attributesOf = (
  attributes: Record<string, string | number | boolean>,
): readonly Otlp.KeyValue[] =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: anyValueOf(value) }))

const statusOf = (snapshot: TracerDef.SpanSnapshot): Otlp.Status => {
  if (snapshot.status !== 'error') {
    return { code: STATUS_CODE_OK }
  }

  const description = snapshot.attributes[STATUS_DESCRIPTION_ATTRIBUTE]

  return typeof description === 'string'
    ? { code: STATUS_CODE_ERROR, message: description }
    : { code: STATUS_CODE_ERROR }
}

const spanOf = (snapshot: TracerDef.SpanSnapshot): Otlp.Span => ({
  traceId: snapshot.context.traceId,
  spanId: snapshot.context.spanId,
  // `undefined` is dropped by the JSON encoder, matching proto field absence
  parentSpanId: snapshot.context.parentSpanId,
  name: snapshot.name,
  kind: SPAN_KINDS[snapshot.kind],
  startTimeUnixNano: nanosOf(snapshot.startMs),
  endTimeUnixNano: nanosOf(snapshot.endMs),
  attributes: attributesOf(snapshot.attributes),
  status: statusOf(snapshot),
  events: snapshot.events.map(event => ({
    timeUnixNano: nanosOf(event.ts),
    name: event.message,
  })),
})

/** Encode one batch as the OTLP/HTTP JSON `ExportTraceServiceRequest`. */
export const encodeSpans = (
  spans: readonly TracerDef.SpanSnapshot[],
  serviceName: string,
): Otlp.ExportRequest => ({
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
      },
      scopeSpans: [{ scope: { name: OTLP_SCOPE_NAME }, spans: spans.map(spanOf) }],
    },
  ],
})
