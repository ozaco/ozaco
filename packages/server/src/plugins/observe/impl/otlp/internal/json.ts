import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

import { CUMULATIVE, SPAN_KINDS, STATUS_ERROR } from './const'
import { isInt64, nanosOf, spanFlags } from './values'

/**
 * OTLP/JSON (the protobuf JSON mapping of opentelemetry-proto): lowerCamelCase FIELD names,
 * attribute keys verbatim (never transformed), trace/span ids as lowercase hex, 64-bit integers
 * (`intValue`, timestamps, counts) as decimal strings, enums as numbers; proto3 defaults (0,
 * empty strings / lists) are left out exactly as the protobuf writer leaves them out, so both
 * encodings decode to the same thing.
 */

/** A double as the JSON mapping writes it (`NaN` / `Infinity` are strings). */
const double = (value: number): number | string =>
  Number.isFinite(value)
    ? value
    : Number.isNaN(value)
      ? 'NaN'
      : value > 0
        ? 'Infinity'
        : '-Infinity'

const anyValue = (value: TraceDef.AttrValue): Helpers.Json => {
  if (typeof value === 'string') {
    return { stringValue: value }
  }

  if (typeof value === 'boolean') {
    return { boolValue: value }
  }

  if (typeof value === 'number') {
    return isInt64(value) ? { intValue: BigInt(value).toString() } : { doubleValue: double(value) }
  }

  // ALWAYS with `values` — `{ arrayValue: {} }` is refused by some backends
  return {
    arrayValue: {
      values: (value as readonly (string | number | boolean)[]).map(item => anyValue(item)),
    },
  }
}

const attributes = (record: TraceDef.Attributes | undefined): Helpers.Json => {
  const entries = Object.entries(record ?? {})

  return entries.length > 0
    ? { attributes: entries.map(([key, value]) => ({ key, value: anyValue(value) })) }
    : {}
}

const count = (name: string, value: number | undefined): Helpers.Json =>
  value !== undefined && value > 0 ? { [name]: value } : {}

const scopeOf = (scope: TraceDef.InstrumentationScope): Helpers.Json => ({
  ...(scope.name ? { name: scope.name } : {}),
  ...(scope.version ? { version: scope.version } : {}),
})

const request = <T>(
  groups: readonly Helpers.ResourceGroup<T>[],
  names: { readonly resource: string; readonly scope: string; readonly items: string },
  item: (value: T) => Helpers.Json,
): Helpers.Json => ({
  [names.resource]: groups.map(group => ({
    resource: attributes(group.resource),
    [names.scope]: group.scopes.map(block => ({
      scope: scopeOf(block.scope),
      [names.items]: block.items.map(value => item(value)),
    })),
  })),
})

// --- traces --------------------------------------------------------------------------------------

const span = (data: TraceDef.SpanData): Helpers.Json => ({
  traceId: data.context.traceId,
  spanId: data.context.spanId,
  ...(data.context.state ? { traceState: data.context.state } : {}),
  ...(data.parent ? { parentSpanId: data.parent.spanId } : {}),
  flags: spanFlags(data.context.flags, data.parent?.remote),
  name: data.name,
  kind: SPAN_KINDS[data.kind],
  startTimeUnixNano: nanosOf(data.start).toString(),
  endTimeUnixNano: nanosOf(data.end).toString(),
  ...attributes(data.attributes),
  ...count('droppedAttributesCount', data.droppedAttributes),
  ...(data.events.length > 0
    ? {
        events: data.events.map(event => ({
          timeUnixNano: nanosOf(event.time).toString(),
          name: event.name,
          ...attributes(event.attributes),
          ...count('droppedAttributesCount', event.droppedAttributes),
        })),
      }
    : {}),
  ...count('droppedEventsCount', data.droppedEvents),
  ...(data.links.length > 0
    ? {
        links: data.links.map(link => ({
          traceId: link.context.traceId,
          spanId: link.context.spanId,
          ...(link.context.state ? { traceState: link.context.state } : {}),
          ...attributes(link.attributes),
          ...count('droppedAttributesCount', link.droppedAttributes),
          flags: spanFlags(link.context.flags, link.context.remote),
        })),
      }
    : {}),
  ...count('droppedLinksCount', data.droppedLinks),
  // unset is OMITTED (never an explicit ok)
  ...(data.status.code === 'error'
    ? {
        status: {
          ...(data.status.message ? { message: data.status.message } : {}),
          code: STATUS_ERROR,
        },
      }
    : {}),
})

// --- logs ----------------------------------------------------------------------------------------

const logRecord = (log: TraceDef.LogData): Helpers.Json => {
  const flags = log.context ? log.context.flags & 0xff : 0

  return {
    timeUnixNano: nanosOf(log.time).toString(),
    ...(log.severityNumber > 0 ? { severityNumber: log.severityNumber } : {}),
    ...(log.severityText ? { severityText: log.severityText } : {}),
    body: anyValue(log.body),
    ...attributes(log.attributes),
    ...count('droppedAttributesCount', log.droppedAttributes),
    ...(flags === 0 ? {} : { flags }),
    ...(log.context ? { traceId: log.context.traceId, spanId: log.context.spanId } : {}),
    observedTimeUnixNano: nanosOf(log.observedTime).toString(),
    ...(log.eventName ? { eventName: log.eventName } : {}),
  }
}

// --- metrics -------------------------------------------------------------------------------------

const numberPoint = (point: Helpers.NumberPoint): Helpers.Json => ({
  startTimeUnixNano: nanosOf(point.start).toString(),
  timeUnixNano: nanosOf(point.time).toString(),
  ...(isInt64(point.value)
    ? { asInt: BigInt(point.value).toString() }
    : { asDouble: double(point.value) }),
  ...attributes(point.attributes),
})

const histogramPoint = (point: Helpers.HistogramPoint): Helpers.Json => ({
  startTimeUnixNano: nanosOf(point.start).toString(),
  timeUnixNano: nanosOf(point.time).toString(),
  count: String(point.count),
  sum: double(point.sum),
  bucketCounts: point.bucketCounts.map(String),
  explicitBounds: [...point.bounds],
  ...attributes(point.attributes),
  min: double(point.min),
  max: double(point.max),
})

const metric = (data: Helpers.Metric): Helpers.Json => {
  const head = {
    name: data.name,
    ...(data.description ? { description: data.description } : {}),
    ...(data.unit ? { unit: data.unit } : {}),
  }

  if (data.kind === 'gauge') {
    return { ...head, gauge: { dataPoints: data.points.map(numberPoint) } }
  }

  if (data.kind === 'sum') {
    return {
      ...head,
      sum: {
        dataPoints: data.points.map(numberPoint),
        aggregationTemporality: CUMULATIVE,
        ...(data.monotonic ? { isMonotonic: true } : {}),
      },
    }
  }

  return {
    ...head,
    histogram: {
      dataPoints: data.points.map(histogramPoint),
      aggregationTemporality: CUMULATIVE,
    },
  }
}

// --- the requests --------------------------------------------------------------------------------

/** `ExportTraceServiceRequest` as OTLP/JSON text. */
export const jsonTraces = (groups: readonly Helpers.ResourceGroup<TraceDef.SpanData>[]): string =>
  JSON.stringify(
    request(groups, { resource: 'resourceSpans', scope: 'scopeSpans', items: 'spans' }, span),
  )

/** `ExportLogsServiceRequest` as OTLP/JSON text. */
export const jsonLogs = (groups: readonly Helpers.ResourceGroup<TraceDef.LogData>[]): string =>
  JSON.stringify(
    request(
      groups,
      { resource: 'resourceLogs', scope: 'scopeLogs', items: 'logRecords' },
      logRecord,
    ),
  )

/** `ExportMetricsServiceRequest` as OTLP/JSON text. */
export const jsonMetrics = (groups: readonly Helpers.ResourceGroup<Helpers.Metric>[]): string =>
  JSON.stringify(
    request(
      groups,
      { resource: 'resourceMetrics', scope: 'scopeMetrics', items: 'metrics' },
      metric,
    ),
  )

/** The `partialSuccess` of an OTLP/JSON `Export*ServiceResponse`; anything malformed reads as
 * fully accepted. */
export const jsonPartial = (text: string): Helpers.Delivery => {
  try {
    const parsed = JSON.parse(text) as { partialSuccess?: Record<string, unknown> | null } | null
    const partial = parsed?.partialSuccess

    if (!partial || typeof partial !== 'object') {
      return { rejected: 0, message: null }
    }

    const rejected = Number(
      partial['rejectedSpans'] ??
        partial['rejectedLogRecords'] ??
        partial['rejectedDataPoints'] ??
        0,
    )
    const message = partial['errorMessage']

    return {
      rejected: Number.isFinite(rejected) ? rejected : 0,
      message: typeof message === 'string' && message !== '' ? message : null,
    }
  } catch {
    return { rejected: 0, message: null }
  }
}
