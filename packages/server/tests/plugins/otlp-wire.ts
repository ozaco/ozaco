// oxlint-disable import/exports-last
/**
 * A tiny, STRICT protobuf decoder of the OTLP `Export*ServiceRequest` messages (field numbers and
 * types per opentelemetry-proto v1) for the exporter tests: it turns the bytes an exporter POSTed
 * back into the OTLP/JSON shape (hex ids, 64-bit integers as decimal strings, lowerCamelCase
 * field names) — so a protobuf payload can be compared field for field with the JSON encoding.
 * An unknown field, a wrong wire type or a trailing byte throws.
 */
import type { AnyType } from 'std:shared'

type Scalar =
  | 'string'
  | 'id'
  | 'uint'
  | 'int64'
  | 'fixed64'
  | 'sfixed64'
  | 'fixed32'
  | 'double'
  | 'bool'

interface Field {
  readonly name: string
  readonly type: Scalar | { readonly message: string }
  readonly repeated?: boolean
  /** a packed `repeated fixed64` / `repeated double`. */
  readonly packed?: 'fixed64' | 'double'
}

const msg = (name: string, message: string, repeated = false): Field => ({
  name,
  type: { message },
  repeated,
})
const val = (name: string, type: Scalar): Field => ({ name, type })

const ATTRIBUTES = (field: number): Record<number, Field> => ({
  [field]: msg('attributes', 'KeyValue', true),
})

const SCHEMA: Record<string, Record<number, Field>> = {
  TracesRequest: { 1: msg('resourceSpans', 'ResourceSpans', true) },
  LogsRequest: { 1: msg('resourceLogs', 'ResourceLogs', true) },
  MetricsRequest: { 1: msg('resourceMetrics', 'ResourceMetrics', true) },

  Resource: { ...ATTRIBUTES(1), 2: val('droppedAttributesCount', 'uint') },
  Scope: {
    1: val('name', 'string'),
    2: val('version', 'string'),
    ...ATTRIBUTES(3),
    4: val('droppedAttributesCount', 'uint'),
  },
  KeyValue: { 1: val('key', 'string'), 2: msg('value', 'AnyValue') },
  AnyValue: {
    1: val('stringValue', 'string'),
    2: val('boolValue', 'bool'),
    3: val('intValue', 'int64'),
    4: val('doubleValue', 'double'),
    5: msg('arrayValue', 'ArrayValue'),
    6: msg('kvlistValue', 'KeyValueList'),
  },
  ArrayValue: { 1: msg('values', 'AnyValue', true) },
  KeyValueList: { 1: msg('values', 'KeyValue', true) },

  ResourceSpans: {
    1: msg('resource', 'Resource'),
    2: msg('scopeSpans', 'ScopeSpans', true),
    3: val('schemaUrl', 'string'),
  },
  ScopeSpans: {
    1: msg('scope', 'Scope'),
    2: msg('spans', 'Span', true),
    3: val('schemaUrl', 'string'),
  },
  Span: {
    1: val('traceId', 'id'),
    2: val('spanId', 'id'),
    3: val('traceState', 'string'),
    4: val('parentSpanId', 'id'),
    5: val('name', 'string'),
    6: val('kind', 'uint'),
    7: val('startTimeUnixNano', 'fixed64'),
    8: val('endTimeUnixNano', 'fixed64'),
    ...ATTRIBUTES(9),
    10: val('droppedAttributesCount', 'uint'),
    11: msg('events', 'SpanEvent', true),
    12: val('droppedEventsCount', 'uint'),
    13: msg('links', 'SpanLink', true),
    14: val('droppedLinksCount', 'uint'),
    15: msg('status', 'Status'),
    16: val('flags', 'fixed32'),
  },
  SpanEvent: {
    1: val('timeUnixNano', 'fixed64'),
    2: val('name', 'string'),
    ...ATTRIBUTES(3),
    4: val('droppedAttributesCount', 'uint'),
  },
  SpanLink: {
    1: val('traceId', 'id'),
    2: val('spanId', 'id'),
    3: val('traceState', 'string'),
    ...ATTRIBUTES(4),
    5: val('droppedAttributesCount', 'uint'),
    6: val('flags', 'fixed32'),
  },
  Status: { 2: val('message', 'string'), 3: val('code', 'uint') },

  ResourceLogs: {
    1: msg('resource', 'Resource'),
    2: msg('scopeLogs', 'ScopeLogs', true),
    3: val('schemaUrl', 'string'),
  },
  ScopeLogs: {
    1: msg('scope', 'Scope'),
    2: msg('logRecords', 'LogRecord', true),
    3: val('schemaUrl', 'string'),
  },
  LogRecord: {
    1: val('timeUnixNano', 'fixed64'),
    2: val('severityNumber', 'uint'),
    3: val('severityText', 'string'),
    5: msg('body', 'AnyValue'),
    ...ATTRIBUTES(6),
    7: val('droppedAttributesCount', 'uint'),
    8: val('flags', 'fixed32'),
    9: val('traceId', 'id'),
    10: val('spanId', 'id'),
    11: val('observedTimeUnixNano', 'fixed64'),
    12: val('eventName', 'string'),
  },

  ResourceMetrics: {
    1: msg('resource', 'Resource'),
    2: msg('scopeMetrics', 'ScopeMetrics', true),
    3: val('schemaUrl', 'string'),
  },
  ScopeMetrics: {
    1: msg('scope', 'Scope'),
    2: msg('metrics', 'Metric', true),
    3: val('schemaUrl', 'string'),
  },
  Metric: {
    1: val('name', 'string'),
    2: val('description', 'string'),
    3: val('unit', 'string'),
    5: msg('gauge', 'Gauge'),
    7: msg('sum', 'Sum'),
    9: msg('histogram', 'Histogram'),
  },
  Gauge: { 1: msg('dataPoints', 'NumberDataPoint', true) },
  Sum: {
    1: msg('dataPoints', 'NumberDataPoint', true),
    2: val('aggregationTemporality', 'uint'),
    3: val('isMonotonic', 'bool'),
  },
  Histogram: {
    1: msg('dataPoints', 'HistogramDataPoint', true),
    2: val('aggregationTemporality', 'uint'),
  },
  NumberDataPoint: {
    2: val('startTimeUnixNano', 'fixed64'),
    3: val('timeUnixNano', 'fixed64'),
    4: val('asDouble', 'double'),
    6: val('asInt', 'sfixed64'),
    ...ATTRIBUTES(7),
    8: val('flags', 'uint'),
  },
  HistogramDataPoint: {
    2: val('startTimeUnixNano', 'fixed64'),
    3: val('timeUnixNano', 'fixed64'),
    4: val('count', 'fixed64'),
    5: val('sum', 'double'),
    6: { name: 'bucketCounts', type: 'fixed64', repeated: true, packed: 'fixed64' },
    7: { name: 'explicitBounds', type: 'double', repeated: true, packed: 'double' },
    ...ATTRIBUTES(9),
    10: val('flags', 'uint'),
    11: val('min', 'double'),
    12: val('max', 'double'),
  },
}

const WIRE: Record<Scalar, number> = {
  string: 2,
  id: 2,
  uint: 0,
  int64: 0,
  bool: 0,
  fixed64: 1,
  sfixed64: 1,
  double: 1,
  fixed32: 5,
}

const decodeMessage = (bytes: Uint8Array, type: string): Record<string, AnyType> => {
  const schema = SCHEMA[type]

  if (!schema) {
    throw new Error(`no schema for ${type}`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Record<string, AnyType> = {}
  let at = 0

  const varint = (): bigint => {
    let value = 0n
    let shift = 0n

    for (;;) {
      if (at >= bytes.length) {
        throw new Error(`${type}: truncated varint`)
      }

      const byte = bytes[at]!
      at += 1
      value |= BigInt(byte & 0x7f) << shift
      shift += 7n

      if ((byte & 0x80) === 0) {
        return value
      }
    }
  }

  const take = (size: number): Uint8Array => {
    if (at + size > bytes.length) {
      throw new Error(`${type}: truncated field`)
    }

    const chunk = bytes.subarray(at, at + size)
    at += size

    return chunk
  }

  const put = (field: Field, value: AnyType) => {
    if (field.repeated) {
      ;(out[field.name] ??= []).push(value)
    } else {
      out[field.name] = value
    }
  }

  while (at < bytes.length) {
    const key = Number(varint())
    const number = key >>> 3
    const wire = key & 7
    const field = schema[number]

    if (!field) {
      throw new Error(`${type}: unknown field ${number}`)
    }

    if (field.packed) {
      if (wire !== 2) {
        throw new Error(`${type}.${field.name}: expected packed`)
      }

      const chunk = take(Number(varint()))
      const packed = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      const values: AnyType[] = []

      for (let offset = 0; offset < chunk.length; offset += 8) {
        values.push(
          field.packed === 'fixed64'
            ? packed.getBigUint64(offset, true).toString()
            : packed.getFloat64(offset, true),
        )
      }

      out[field.name] = [...(out[field.name] ?? []), ...values]
      continue
    }

    if (typeof field.type === 'object') {
      if (wire !== 2) {
        throw new Error(`${type}.${field.name}: expected a message`)
      }

      const nested = decodeMessage(take(Number(varint())), field.type.message)

      // proto3 leaves an empty list out; the JSON mapping of an `ArrayValue` always has `values`
      if (field.type.message === 'ArrayValue') {
        nested['values'] ??= []
      }

      put(field, nested)
      continue
    }

    if (WIRE[field.type] !== wire) {
      throw new Error(`${type}.${field.name}: wire type ${wire}, expected ${WIRE[field.type]}`)
    }

    switch (field.type) {
      case 'string': {
        put(field, new TextDecoder().decode(take(Number(varint()))))
        break
      }
      case 'id': {
        put(field, Buffer.from(take(Number(varint()))).toString('hex'))
        break
      }
      case 'uint': {
        put(field, Number(varint()))
        break
      }
      case 'bool': {
        put(field, varint() !== 0n)
        break
      }
      case 'int64': {
        put(field, BigInt.asIntN(64, varint()).toString())
        break
      }
      case 'fixed64': {
        put(field, view.getBigUint64(at, true).toString())
        at += 8
        break
      }
      case 'sfixed64': {
        put(field, view.getBigInt64(at, true).toString())
        at += 8
        break
      }
      case 'double': {
        put(field, view.getFloat64(at, true))
        at += 8
        break
      }
      case 'fixed32': {
        put(field, view.getUint32(at, true))
        at += 4
        break
      }
      default: {
        throw new Error(`${type}.${field.name}: unknown type`)
      }
    }
  }

  if (at !== bytes.length) {
    throw new Error(`${type}: ${bytes.length - at} trailing byte(s)`)
  }

  return out
}

/** Decode an `ExportTraceServiceRequest` / `ExportLogsServiceRequest` /
 * `ExportMetricsServiceRequest` into its OTLP/JSON shape. */
export const decodeOtlp = (
  signal: 'traces' | 'logs' | 'metrics',
  bytes: Uint8Array,
): Record<string, AnyType> =>
  decodeMessage(
    bytes,
    signal === 'traces' ? 'TracesRequest' : signal === 'logs' ? 'LogsRequest' : 'MetricsRequest',
  )

/** One POST the fake collector received. */
export interface Received {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Uint8Array
}

/** The OTLP/JSON shape of a received request, whatever its encoding (protobuf decoded, JSON
 * parsed; gzip undone). */
export const payloadOf = (entry: Received): Record<string, AnyType> => {
  const raw =
    entry.headers['content-encoding'] === 'gzip'
      ? Bun.gunzipSync(new Uint8Array(entry.body))
      : entry.body
  const signal = entry.url.endsWith('/v1/traces')
    ? 'traces'
    : entry.url.endsWith('/v1/logs')
      ? 'logs'
      : 'metrics'

  return entry.headers['content-type'] === 'application/json'
    ? JSON.parse(new TextDecoder().decode(raw))
    : decodeOtlp(signal, raw)
}

/** A fake OTLP collector: records every POST (headers lower-cased, body as bytes) and answers
 * with `answer(entry)` (default 200 `{}`). */
export const fakeCollector = (
  answer?: (entry: Received, index: number) => Response | Promise<Response>,
) => {
  const received: Received[] = []

  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}

    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers[key] = value
    }

    const body =
      typeof init?.body === 'string'
        ? new TextEncoder().encode(init.body)
        : new Uint8Array(init?.body as ArrayBufferLike)
    const entry: Received = { url: String(url), headers, body }
    received.push(entry)

    try {
      return Promise.resolve(
        answer ? answer(entry, received.length - 1) : new Response('{}', { status: 200 }),
      )
    } catch (error) {
      // an answer that throws is a network failure
      return Promise.reject(error)
    }
  }) as typeof fetch

  const of = (suffix: string) => received.filter(entry => entry.url.endsWith(suffix))

  /** Every span the collector saw, each with its resource's `service.name`. */
  const spans = (): AnyType[] =>
    of('/v1/traces').flatMap(entry =>
      (payloadOf(entry)['resourceSpans'] ?? []).flatMap((block: AnyType) =>
        block.scopeSpans.flatMap((scope: AnyType) =>
          scope.spans.map((span: AnyType) => ({
            ...span,
            $service: attrOf(block.resource, 'service.name'),
            $scope: scope.scope.name,
          })),
        ),
      ),
    )

  const logs = (): AnyType[] =>
    of('/v1/logs').flatMap(entry =>
      (payloadOf(entry)['resourceLogs'] ?? []).flatMap((block: AnyType) =>
        block.scopeLogs.flatMap((scope: AnyType) =>
          scope.logRecords.map((record: AnyType) => ({
            ...record,
            $service: attrOf(block.resource, 'service.name'),
            $scope: scope.scope.name,
          })),
        ),
      ),
    )

  /** The metrics of the LAST metrics export, each with its resource's `service.name`. */
  const metrics = (): AnyType[] => {
    const last = of('/v1/metrics').at(-1)

    return last
      ? (payloadOf(last)['resourceMetrics'] ?? []).flatMap((block: AnyType) =>
          block.scopeMetrics.flatMap((scope: AnyType) =>
            scope.metrics.map((metric: AnyType) => ({
              ...metric,
              $service: attrOf(block.resource, 'service.name'),
            })),
          ),
        )
      : []
  }

  return { fetch: fetchImpl, received, of, spans, logs, metrics }
}

/** The JSON value of attribute `key` in an OTLP `attributes` list holder (a span, a resource…),
 * unwrapped (`{ stringValue: 'x' }` → `'x'`, `intValue` → number, arrays → arrays). */
export const attrOf = (holder: AnyType, key: string): AnyType => {
  const found = (holder?.attributes ?? []).find((entry: AnyType) => entry.key === key)

  return found ? unwrap(found.value) : undefined
}

const unwrap = (value: AnyType): AnyType => {
  if ('stringValue' in value) {
    return value.stringValue
  }

  if ('intValue' in value) {
    return Number(value.intValue)
  }

  if ('doubleValue' in value) {
    return value.doubleValue
  }

  if ('boolValue' in value) {
    return value.boolValue
  }

  if ('arrayValue' in value) {
    return (value.arrayValue.values ?? []).map(unwrap)
  }

  return value
}

/** Every attribute of a holder, unwrapped, as a plain object. */
export const attrsOf = (holder: AnyType): Record<string, AnyType> =>
  Object.fromEntries(
    (holder?.attributes ?? []).map((entry: AnyType) => [entry.key, unwrap(entry.value)]),
  )
