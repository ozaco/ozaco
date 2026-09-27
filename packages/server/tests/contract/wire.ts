// oxlint-disable import/exports-last
/**
 * The contract tests' decoders: every sink's OUTPUT read back into one normalized record shape,
 * each decoder written against the sink's published format only (OTLP/JSON, the OTLP protobuf wire
 * format, the stdout lines, the store's rows) — never through the encoder that wrote it.
 *
 * Two shapes:
 * - {@link Span} / {@link Log}: EVERYTHING a machine-readable sink carries (typed attribute values,
 *   epoch-ns times, flags, trace state, scope, the whole resource).
 * - {@link TextSpan} / {@link TextLog}: what the stdout lines can carry too — ids, parent, name,
 *   kind, service, status code + message, attributes as sorted `key=value` pairs (a value as its
 *   text), event names + attributes, link targets + attributes; for logs the severity range,
 *   body, event name, scope and attributes. {@link textSpan} / {@link textLog} project a full
 *   record onto it.
 */
import type { ObserveDef } from 'server:core'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

// --- the normalized records ----------------------------------------------------------------------

export type Scalar = string | number | boolean
export type Value = Scalar | readonly Scalar[]
export type Attrs = Readonly<Record<string, Value>>

export interface Scope {
  readonly name: string
  readonly version: string | null
}

export interface SpanEvent {
  readonly name: string
  /** epoch nanoseconds, decimal. */
  readonly time: string
  readonly attributes: Attrs
  readonly droppedAttributes: number
}

export interface SpanLink {
  readonly traceId: string
  readonly spanId: string
  readonly traceState: string | null
  /** the W3C trace flags (low byte). */
  readonly traceFlags: number
  readonly remote: boolean
  readonly attributes: Attrs
  readonly droppedAttributes: number
}

export interface Span {
  readonly traceId: string
  readonly spanId: string
  readonly parentId: string | null
  readonly parentRemote: boolean
  readonly traceFlags: number
  readonly traceState: string | null
  readonly name: string
  readonly kind: TraceDef.SpanKind
  readonly status: { readonly code: 'unset' | 'error'; readonly message: string | null }
  readonly start: string
  readonly end: string
  readonly scope: Scope
  readonly resource: Attrs
  readonly attributes: Attrs
  readonly droppedAttributes: number
  readonly events: readonly SpanEvent[]
  readonly droppedEvents: number
  readonly links: readonly SpanLink[]
  readonly droppedLinks: number
}

export interface Log {
  readonly traceId: string | null
  readonly spanId: string | null
  readonly traceFlags: number
  readonly time: string
  readonly observedTime: string
  readonly severityNumber: number
  readonly severityText: string | null
  readonly body: string
  readonly eventName: string | null
  readonly scope: Scope
  readonly resource: Attrs
  readonly attributes: Attrs
  readonly droppedAttributes: number
}

export interface TextSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentId: string | null
  readonly name: string
  readonly kind: string
  readonly service: string
  /** `unset`, `error` or `error: <message>`. */
  readonly status: string
  readonly attributes: readonly string[]
  readonly events: readonly { readonly name: string; readonly attributes: readonly string[] }[]
  readonly links: readonly {
    readonly traceId: string
    readonly spanId: string
    readonly attributes: readonly string[]
  }[]
  /** `attributes=<n> events=<n> links=<n>`. */
  readonly dropped: string
}

export interface TextLog {
  readonly traceId: string | null
  readonly spanId: string | null
  /** the severity RANGE: TRACE, DEBUG, INFO, WARN, ERROR, FATAL. */
  readonly severity: string
  readonly body: string
  readonly eventName: string | null
  readonly service: string
  readonly scope: string
  readonly attributes: readonly string[]
}

export interface Records<TSpan, TLog> {
  readonly spans: readonly TSpan[]
  readonly logs: readonly TLog[]
}

// --- shared helpers ------------------------------------------------------------------------------

const KINDS: readonly TraceDef.SpanKind[] = ['internal', 'server', 'client', 'producer', 'consumer']
const SEVERITIES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const

/** Span / link flags bits 8 and 9 (OTLP): "is-remote known" and "is remote". */
const IS_REMOTE = 0x2_00

/** Epoch ms (sub-ms fraction) → epoch ns: whole milliseconds and the fraction apart, so nothing
 * is lost to a double's 53 bits (the conversion every OTLP writer has to make). */
export const nanos = (ms: number): string => {
  const whole = Math.floor(ms)

  return (BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))).toString()
}

/** An OTel severity number's range name. */
export const severityRange = (severity: number): string =>
  SEVERITIES[Math.min(5, Math.max(0, Math.floor((severity - 1) / 4)))] ?? String(severity)

/** An attribute value as its text: a primitive as `String()` writes it, an array as JSON. */
export const valueText = (value: Value): string =>
  Array.isArray(value) ? JSON.stringify(value) : String(value)

const pairs = (attributes: Attrs): string[] =>
  Object.entries(attributes)
    .map(([key, value]) => `${key}=${valueText(value)}`)
    .toSorted()

const sortedAttrs = (attributes: Readonly<Record<string, unknown>> | undefined): Attrs =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).toSorted(([left], [right]) => (left < right ? -1 : 1)),
  ) as Attrs

const byId = <T extends { readonly spanId: string }>(left: T, right: T): number =>
  left.spanId < right.spanId ? -1 : left.spanId > right.spanId ? 1 : 0

const byJson = <T>(left: T, right: T): number => {
  const [a, b] = [JSON.stringify(left), JSON.stringify(right)]

  return a < b ? -1 : a > b ? 1 : 0
}

/** Records in a canonical order (spans by id, logs by content) — a set, compared with toEqual. */
export const canonical = <TSpan extends { readonly spanId: string }, TLog>(
  records: Records<TSpan, TLog>,
): Records<TSpan, TLog> => ({
  spans: records.spans.toSorted(byId),
  logs: records.logs.toSorted(byJson),
})

/** The stdout-expressible projection of a full span. */
export const textSpan = (span: Span): TextSpan => ({
  traceId: span.traceId,
  spanId: span.spanId,
  parentId: span.parentId,
  name: span.name,
  kind: span.kind.toUpperCase(),
  service: String(span.resource['service.name']),
  status:
    span.status.code === 'error'
      ? span.status.message
        ? `error: ${span.status.message}`
        : 'error'
      : 'unset',
  attributes: pairs(span.attributes),
  events: span.events.map(event => ({ name: event.name, attributes: pairs(event.attributes) })),
  links: span.links.map(link => ({
    traceId: link.traceId,
    spanId: link.spanId,
    attributes: pairs(link.attributes),
  })),
  dropped: `attributes=${span.droppedAttributes} events=${span.droppedEvents} links=${span.droppedLinks}`,
})

/** The stdout-expressible projection of a full log record. */
export const textLog = (log: Log): TextLog => ({
  traceId: log.traceId,
  spanId: log.spanId,
  severity: severityRange(log.severityNumber),
  body: log.body,
  eventName: log.eventName,
  service: String(log.resource['service.name']),
  scope: log.scope.name,
  attributes: pairs(log.attributes),
})

export const textRecords = (records: Records<Span, Log>): Records<TextSpan, TextLog> =>
  canonical({ spans: records.spans.map(textSpan), logs: records.logs.map(textLog) })

// --- the kernel's events (a memory ObserveExporter): the reference ------------------------------

const scopeOf = (scope: TraceDef.InstrumentationScope): Scope => ({
  name: scope.name,
  version: scope.version ?? null,
})

const eventOf = (event: TraceDef.SpanEvent): SpanEvent => ({
  name: event.name,
  time: nanos(event.time),
  attributes: sortedAttrs(event.attributes),
  droppedAttributes: event.droppedAttributes ?? 0,
})

const linkOf = (link: TraceDef.Link): SpanLink => ({
  traceId: link.context.traceId,
  spanId: link.context.spanId,
  traceState: link.context.state ?? null,
  traceFlags: link.context.flags & 0xff,
  remote: link.context.remote === true,
  attributes: sortedAttrs(link.attributes),
  droppedAttributes: link.droppedAttributes ?? 0,
})

/** What the kernel handed its sinks. */
export const fromEvents = (events: readonly ObserveDef.Event[]): Records<Span, Log> =>
  canonical({
    spans: events.flatMap(event =>
      event.t === 'span'
        ? [
            {
              traceId: event.span.context.traceId,
              spanId: event.span.context.spanId,
              parentId: event.span.parent?.spanId ?? null,
              parentRemote: event.span.parent?.remote === true,
              traceFlags: event.span.context.flags & 0xff,
              traceState: event.span.context.state ?? null,
              name: event.span.name,
              kind: event.span.kind,
              status: { code: event.span.status.code, message: event.span.status.message ?? null },
              start: nanos(event.span.start),
              end: nanos(event.span.end),
              scope: scopeOf(event.span.scope),
              resource: sortedAttrs(event.resource),
              attributes: sortedAttrs(event.span.attributes),
              droppedAttributes: event.span.droppedAttributes,
              events: event.span.events.map(eventOf),
              droppedEvents: event.span.droppedEvents,
              links: event.span.links.map(linkOf),
              droppedLinks: event.span.droppedLinks,
            },
          ]
        : [],
    ),
    logs: events.flatMap(event =>
      event.t === 'log'
        ? [
            {
              traceId: event.log.context?.traceId ?? null,
              spanId: event.log.context?.spanId ?? null,
              traceFlags: (event.log.context?.flags ?? 0) & 0xff,
              time: nanos(event.log.time),
              observedTime: nanos(event.log.observedTime),
              severityNumber: event.log.severityNumber,
              severityText: event.log.severityText ?? null,
              body: event.log.body,
              eventName: event.log.eventName ?? null,
              scope: scopeOf(event.log.scope),
              resource: sortedAttrs(event.resource),
              attributes: sortedAttrs(event.log.attributes),
              droppedAttributes: event.log.droppedAttributes,
            },
          ]
        : [],
    ),
  })

// --- the store (ObservePlugin): its rows, as `Observe.actions.trace()` answers them ------------

/** Every stored span / log record of the given trace views. */
export const fromStore = (views: readonly ObserveDef.TraceView[]): Records<Span, Log> =>
  canonical({
    spans: views.flatMap(view =>
      view.spans.map((row): Span => ({
        traceId: row.trace_id,
        spanId: row.span_id,
        parentId: row.parent_span_id,
        parentRemote: row.root && row.parent_span_id !== null,
        traceFlags: row.flags & 0xff,
        traceState: row.trace_state,
        name: row.name,
        kind: row.kind,
        status: { code: row.status_code, message: row.status_message },
        start: nanos(row.start),
        end: nanos(row.end),
        scope: { name: row.scope, version: row.scope_version },
        resource: sortedAttrs({
          ...row.resource,
          'service.name': row.service_name,
          'service.instance.id': row.service_instance_id,
        }),
        attributes: sortedAttrs(row.attributes),
        droppedAttributes: row.dropped_attributes,
        events: row.events.map(eventOf),
        droppedEvents: row.dropped_events,
        links: row.links.map(linkOf),
        droppedLinks: row.dropped_links,
      })),
    ),
    logs: views.flatMap(view =>
      view.logs.map((row): Log => ({
        traceId: row.trace_id,
        spanId: row.span_id,
        traceFlags: (row.flags ?? 0) & 0xff,
        time: nanos(row.time),
        observedTime: nanos(row.observed_time),
        severityNumber: row.severity_number,
        severityText: row.severity_text,
        body: row.body,
        eventName: row.event_name,
        scope: { name: row.scope, version: row.scope_version },
        resource: sortedAttrs({
          ...row.resource,
          'service.name': row.service_name,
          'service.instance.id': row.service_instance_id,
        }),
        attributes: sortedAttrs(row.attributes),
        droppedAttributes: row.dropped_attributes,
      })),
    ),
  })

// --- OTLP/JSON -----------------------------------------------------------------------------------

const jsonValue = (value: AnyType): Value => {
  if ('stringValue' in value) {
    return value.stringValue
  }

  if ('boolValue' in value) {
    return value.boolValue
  }

  if ('intValue' in value) {
    return Number(value.intValue)
  }

  if ('doubleValue' in value) {
    return Number(value.doubleValue)
  }

  if ('arrayValue' in value) {
    return (value.arrayValue.values ?? []).map((item: AnyType) => jsonValue(item) as Scalar)
  }

  throw new Error(`OTLP/JSON: an AnyValue ozaco never writes: ${JSON.stringify(value)}`)
}

const jsonAttrs = (list: readonly AnyType[] | undefined): Attrs =>
  sortedAttrs(Object.fromEntries((list ?? []).map(entry => [entry.key, jsonValue(entry.value)])))

const jsonScope = (scope: AnyType): Scope => ({
  name: scope?.name ?? '',
  version: scope?.version || null,
})

const flagsOf = (flags: number | undefined) => ({
  traceFlags: (flags ?? 0) & 0xff,
  remote: ((flags ?? 0) & IS_REMOTE) !== 0,
})

const jsonSpan = (span: AnyType, scope: Scope, resource: Attrs): Span => {
  const flags = flagsOf(span.flags)

  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentId: span.parentSpanId || null,
    parentRemote: flags.remote,
    traceFlags: flags.traceFlags,
    traceState: span.traceState || null,
    name: span.name,
    kind: KINDS[(span.kind ?? 0) - 1] ?? ('unspecified' as TraceDef.SpanKind),
    status:
      span.status?.code === 2
        ? { code: 'error', message: span.status.message || null }
        : { code: 'unset', message: null },
    start: span.startTimeUnixNano,
    end: span.endTimeUnixNano,
    scope,
    resource,
    attributes: jsonAttrs(span.attributes),
    droppedAttributes: span.droppedAttributesCount ?? 0,
    events: (span.events ?? []).map((event: AnyType) => ({
      name: event.name,
      time: event.timeUnixNano,
      attributes: jsonAttrs(event.attributes),
      droppedAttributes: event.droppedAttributesCount ?? 0,
    })),
    droppedEvents: span.droppedEventsCount ?? 0,
    links: (span.links ?? []).map((link: AnyType): SpanLink => {
      const linked = flagsOf(link.flags)

      return {
        traceId: link.traceId,
        spanId: link.spanId,
        traceState: link.traceState || null,
        traceFlags: linked.traceFlags,
        remote: linked.remote,
        attributes: jsonAttrs(link.attributes),
        droppedAttributes: link.droppedAttributesCount ?? 0,
      }
    }),
    droppedLinks: span.droppedLinksCount ?? 0,
  }
}

const jsonLog = (record: AnyType, scope: Scope, resource: Attrs): Log => {
  const body = jsonValue(record.body)

  if (typeof body !== 'string') {
    throw new TypeError(`OTLP/JSON: a log body that is no string: ${JSON.stringify(record.body)}`)
  }

  return {
    traceId: record.traceId || null,
    spanId: record.spanId || null,
    traceFlags: (record.flags ?? 0) & 0xff,
    time: record.timeUnixNano,
    observedTime: record.observedTimeUnixNano,
    severityNumber: record.severityNumber ?? 0,
    severityText: record.severityText || null,
    body,
    eventName: record.eventName || null,
    scope,
    resource,
    attributes: jsonAttrs(record.attributes),
    droppedAttributes: record.droppedAttributesCount ?? 0,
  }
}

/** Every span and log record of OTLP/JSON `ExportTraceServiceRequest` /
 * `ExportLogsServiceRequest` bodies. */
export const fromOtlpJson = (payloads: {
  readonly traces: readonly string[]
  readonly logs: readonly string[]
}): Records<Span, Log> =>
  canonical({
    spans: payloads.traces.flatMap(text =>
      (JSON.parse(text).resourceSpans ?? []).flatMap((block: AnyType) => {
        const resource = jsonAttrs(block.resource?.attributes)

        return (block.scopeSpans ?? []).flatMap((scoped: AnyType) =>
          (scoped.spans ?? []).map((span: AnyType) =>
            jsonSpan(span, jsonScope(scoped.scope), resource),
          ),
        )
      }),
    ),
    logs: payloads.logs.flatMap(text =>
      (JSON.parse(text).resourceLogs ?? []).flatMap((block: AnyType) => {
        const resource = jsonAttrs(block.resource?.attributes)

        return (block.scopeLogs ?? []).flatMap((scoped: AnyType) =>
          (scoped.logRecords ?? []).map((record: AnyType) =>
            jsonLog(record, jsonScope(scoped.scope), resource),
          ),
        )
      }),
    ),
  })

// --- OTLP protobuf: a tiny wire-format reader -----------------------------------------------------

/** Protobuf wire types. */
const VARINT = 0
const I64 = 1
const LEN = 2
const I32 = 5

interface Field {
  readonly wire: number
  /** a VARINT's value. */
  readonly int: bigint
  /** a LEN field's bytes, or the 8 / 4 bytes of an I64 / I32. */
  readonly bytes: Uint8Array
}

/**
 * The fields of one message, by number — STRICT: a field number `known` does not list, or one
 * arriving with another wire type, throws (an encoder writing something the OTLP schema does not
 * have is a bug the test must see), as does a truncated or trailing byte.
 */
const readMessage = (
  bytes: Uint8Array,
  name: string,
  known: Readonly<Record<number, number>>,
): Map<number, Field[]> => {
  const fields = new Map<number, Field[]>()
  let at = 0

  const varint = (): bigint => {
    let value = 0n
    let shift = 0n

    for (;;) {
      if (at >= bytes.length) {
        throw new Error(`${name}: truncated varint`)
      }

      const byte = bytes[at] as number
      at += 1
      value |= BigInt(byte & 0x7f) << shift
      shift += 7n

      if ((byte & 0x80) === 0) {
        return value
      }
    }
  }

  const take = (size: number): Uint8Array => {
    if (size < 0 || at + size > bytes.length) {
      throw new Error(`${name}: truncated field`)
    }

    const chunk = bytes.subarray(at, at + size)
    at += size

    return chunk
  }

  while (at < bytes.length) {
    const key = varint()
    const number = Number(key >> 3n)
    const wire = Number(key & 7n)

    if (known[number] === undefined) {
      throw new Error(`${name}: field ${number} is not in the OTLP schema`)
    }

    if (known[number] !== wire) {
      throw new Error(`${name}: field ${number} has wire type ${wire}, expected ${known[number]}`)
    }

    const field: Field =
      wire === VARINT
        ? { wire, int: varint(), bytes: new Uint8Array(0) }
        : wire === I64
          ? { wire, int: 0n, bytes: take(8) }
          : wire === I32
            ? { wire, int: 0n, bytes: take(4) }
            : { wire, int: 0n, bytes: take(Number(varint())) }

    fields.set(number, [...(fields.get(number) ?? []), field])
  }

  return fields
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** The one value of a singular field, or undefined. */
const one = (fields: Map<number, Field[]>, number: number): Field | undefined => {
  const found = fields.get(number) ?? []

  if (found.length > 1) {
    throw new Error(`field ${number} repeated in a singular slot`)
  }

  return found[0]
}

const str = (fields: Map<number, Field[]>, number: number): string => {
  const field = one(fields, number)

  return field ? decoder.decode(field.bytes) : ''
}

const hex = (fields: Map<number, Field[]>, number: number): string =>
  [...(one(fields, number)?.bytes ?? [])].map(byte => byte.toString(16).padStart(2, '0')).join('')

const uint = (fields: Map<number, Field[]>, number: number): number =>
  Number(one(fields, number)?.int ?? 0n)

const fixed64 = (fields: Map<number, Field[]>, number: number): string => {
  const field = one(fields, number)

  return field
    ? new DataView(field.bytes.buffer, field.bytes.byteOffset, 8).getBigUint64(0, true).toString()
    : '0'
}

const fixed32 = (fields: Map<number, Field[]>, number: number): number => {
  const field = one(fields, number)

  return field ? new DataView(field.bytes.buffer, field.bytes.byteOffset, 4).getUint32(0, true) : 0
}

const many = (fields: Map<number, Field[]>, number: number): Uint8Array[] =>
  (fields.get(number) ?? []).map(field => field.bytes)

/** `AnyValue`: 1 string, 2 bool, 3 int64, 4 double, 5 ArrayValue (6 kvlist / 7 bytes: never). */
const pbValue = (bytes: Uint8Array): Value => {
  const fields = readMessage(bytes, 'AnyValue', { 1: LEN, 2: VARINT, 3: VARINT, 4: I64, 5: LEN })

  if (fields.size !== 1) {
    throw new Error(`AnyValue: ${fields.size} value fields set`)
  }

  if (fields.has(1)) {
    return str(fields, 1)
  }

  if (fields.has(2)) {
    return one(fields, 2)!.int !== 0n
  }

  if (fields.has(3)) {
    return Number(BigInt.asIntN(64, one(fields, 3)!.int))
  }

  if (fields.has(4)) {
    const field = one(fields, 4)!

    return new DataView(field.bytes.buffer, field.bytes.byteOffset, 8).getFloat64(0, true)
  }

  const array = readMessage(one(fields, 5)!.bytes, 'ArrayValue', { 1: LEN })

  return many(array, 1).map(item => pbValue(item) as Scalar)
}

/** repeated `KeyValue` (1 key, 2 AnyValue). */
const pbAttrs = (list: readonly Uint8Array[]): Attrs =>
  sortedAttrs(
    Object.fromEntries(
      list.map(bytes => {
        const fields = readMessage(bytes, 'KeyValue', { 1: LEN, 2: LEN })
        const value = one(fields, 2)

        if (!value) {
          throw new Error(`KeyValue ${str(fields, 1)}: no value`)
        }

        return [str(fields, 1), pbValue(value.bytes)]
      }),
    ),
  )

/** `Resource` (1 attributes, 2 dropped). */
const pbResource = (bytes: Uint8Array | undefined): Attrs =>
  bytes ? pbAttrs(many(readMessage(bytes, 'Resource', { 1: LEN, 2: VARINT }), 1)) : {}

/** `InstrumentationScope` (1 name, 2 version, 3 attributes, 4 dropped). */
const pbScope = (bytes: Uint8Array | undefined): Scope => {
  const fields = bytes
    ? readMessage(bytes, 'InstrumentationScope', { 1: LEN, 2: LEN, 3: LEN, 4: VARINT })
    : new Map<number, Field[]>()

  return { name: str(fields, 1), version: str(fields, 2) || null }
}

const SPAN_FIELDS = {
  1: LEN,
  2: LEN,
  3: LEN,
  4: LEN,
  5: LEN,
  6: VARINT,
  7: I64,
  8: I64,
  9: LEN,
  10: VARINT,
  11: LEN,
  12: VARINT,
  13: LEN,
  14: VARINT,
  15: LEN,
  16: I32,
} as const

/** `Span` (opentelemetry-proto trace/v1). */
const pbSpan = (bytes: Uint8Array, scope: Scope, resource: Attrs): Span => {
  const fields = readMessage(bytes, 'Span', SPAN_FIELDS)
  const flags = flagsOf(fixed32(fields, 16))
  const status = readMessage(one(fields, 15)?.bytes ?? new Uint8Array(0), 'Status', {
    2: LEN,
    3: VARINT,
  })

  return {
    traceId: hex(fields, 1),
    spanId: hex(fields, 2),
    parentId: hex(fields, 4) || null,
    parentRemote: flags.remote,
    traceFlags: flags.traceFlags,
    traceState: str(fields, 3) || null,
    name: str(fields, 5),
    kind: KINDS[uint(fields, 6) - 1] ?? ('unspecified' as TraceDef.SpanKind),
    status:
      uint(status, 3) === 2
        ? { code: 'error', message: str(status, 2) || null }
        : { code: 'unset', message: null },
    start: fixed64(fields, 7),
    end: fixed64(fields, 8),
    scope,
    resource,
    attributes: pbAttrs(many(fields, 9)),
    droppedAttributes: uint(fields, 10),
    events: many(fields, 11).map(event => {
      const at = readMessage(event, 'Span.Event', { 1: I64, 2: LEN, 3: LEN, 4: VARINT })

      return {
        name: str(at, 2),
        time: fixed64(at, 1),
        attributes: pbAttrs(many(at, 3)),
        droppedAttributes: uint(at, 4),
      }
    }),
    droppedEvents: uint(fields, 12),
    links: many(fields, 13).map(link => {
      const at = readMessage(link, 'Span.Link', {
        1: LEN,
        2: LEN,
        3: LEN,
        4: LEN,
        5: VARINT,
        6: I32,
      })

      const linked = flagsOf(fixed32(at, 6))

      return {
        traceId: hex(at, 1),
        spanId: hex(at, 2),
        traceState: str(at, 3) || null,
        traceFlags: linked.traceFlags,
        remote: linked.remote,
        attributes: pbAttrs(many(at, 4)),
        droppedAttributes: uint(at, 5),
      }
    }),
    droppedLinks: uint(fields, 14),
  }
}

/** `LogRecord` (opentelemetry-proto logs/v1). */
const pbLog = (bytes: Uint8Array, scope: Scope, resource: Attrs): Log => {
  const fields = readMessage(bytes, 'LogRecord', {
    1: I64,
    2: VARINT,
    3: LEN,
    5: LEN,
    6: LEN,
    7: VARINT,
    8: I32,
    9: LEN,
    10: LEN,
    11: I64,
    12: LEN,
  })
  const body = one(fields, 5)
  const text = body ? pbValue(body.bytes) : ''

  if (typeof text !== 'string') {
    throw new TypeError('LogRecord: a body that is no string')
  }

  return {
    traceId: hex(fields, 9) || null,
    spanId: hex(fields, 10) || null,
    traceFlags: fixed32(fields, 8) & 0xff,
    time: fixed64(fields, 1),
    observedTime: fixed64(fields, 11),
    severityNumber: uint(fields, 2),
    severityText: str(fields, 3) || null,
    body: text,
    eventName: str(fields, 12) || null,
    scope,
    resource,
    attributes: pbAttrs(many(fields, 6)),
    droppedAttributes: uint(fields, 7),
  }
}

/** Every span and log record of OTLP protobuf `ExportTraceServiceRequest` /
 * `ExportLogsServiceRequest` bodies. */
export const fromOtlpProtobuf = (payloads: {
  readonly traces: readonly Uint8Array[]
  readonly logs: readonly Uint8Array[]
}): Records<Span, Log> => {
  const blocks = (bytes: Uint8Array, kind: 'Spans' | 'Logs') =>
    many(readMessage(bytes, `Export${kind}Request`, { 1: LEN }), 1).map(block =>
      readMessage(block, `Resource${kind}`, { 1: LEN, 2: LEN, 3: LEN }),
    )
  const scoped = (bytes: Uint8Array, kind: 'Spans' | 'Logs') =>
    readMessage(bytes, `Scope${kind}`, { 1: LEN, 2: LEN, 3: LEN })

  return canonical({
    spans: payloads.traces.flatMap(bytes =>
      blocks(bytes, 'Spans').flatMap(block => {
        const resource = pbResource(one(block, 1)?.bytes)

        return many(block, 2).flatMap(item => {
          const scope = scoped(item, 'Spans')

          return many(scope, 2).map(span => pbSpan(span, pbScope(one(scope, 1)?.bytes), resource))
        })
      }),
    ),
    logs: payloads.logs.flatMap(bytes =>
      blocks(bytes, 'Logs').flatMap(block => {
        const resource = pbResource(one(block, 1)?.bytes)

        return many(block, 2).flatMap(item => {
          const scope = scoped(item, 'Logs')

          return many(scope, 2).map(log => pbLog(log, pbScope(one(scope, 1)?.bytes), resource))
        })
      }),
    ),
  })
}

// --- stdout (StdoutExporter) ---------------------------------------------------------------------

/** One `key=value` token's value at `at` of `line`: `"…"` (a JSON string), `[…]` (a JSON array)
 * or a bare word. Returns the value's text and where it ends. */
const tokenAt = (line: string, at: number): { text: string; end: number } => {
  const first = line[at]

  if (first === '"') {
    for (let end = at + 1; end < line.length; end += 1) {
      if (line[end] === '\\') {
        end += 1
      } else if (line[end] === '"') {
        return { text: JSON.parse(line.slice(at, end + 1)) as string, end: end + 1 }
      }
    }

    throw new Error(`stdout: an unterminated string in ${line}`)
  }

  if (first === '[') {
    let quoted = false

    for (let end = at + 1; end < line.length; end += 1) {
      const char = line[end]

      if (quoted && char === '\\') {
        end += 1
      } else if (char === '"') {
        quoted = !quoted
      } else if (!quoted && char === ']') {
        try {
          return { text: JSON.stringify(JSON.parse(line.slice(at, end + 1))), end: end + 1 }
        } catch {
          break
        }
      }
    }
  }

  const space = line.slice(at).search(/\s/u)
  const end = space === -1 ? line.length : at + space

  return { text: line.slice(at, end), end }
}

/** ` key=value key=value…` from `at` to the end of the line, or null when it is not one. */
const tokensFrom = (line: string, from: number): Map<string, string> | null => {
  const tokens = new Map<string, string>()
  let at = from

  while (at < line.length) {
    const head = /^ ([^\s=]+)=/u.exec(line.slice(at))

    if (!head) {
      return null
    }

    const value = tokenAt(line, at + head[0].length)
    tokens.set(head[1]!, value.text)
    at = value.end
  }

  return tokens
}

const pairsOf = (tokens: Map<string, string>): string[] =>
  [...tokens].map(([key, value]) => `${key}=${value}`).toSorted()

const SPAN_LINE =
  /^\[oz\] \d\d:\d\d:\d\d\.\d{3} (\S+) (INTERNAL|SERVER|CLIENT|PRODUCER|CONSUMER) (.*)$/u
const LOG_LINE = /^\[oz\] \d\d:\d\d:\d\d\.\d{3} (\S+) (\S+) (\S+)(?: \[([^\]\s]+)\])? (.*)$/u
const IDS = / trace_id=([0-9a-f]{32}) span_id=([0-9a-f]{16})/gu
const SPAN_HEAD = /^(.*?) \d+\.\d{2}ms (ok|✗ .*)$/u
const EVENT_LINE = /^ {4}· \S+ \+\d+\.\d{2}ms (\S+)/u
const LINK_LINE = /^ {4}↗ link trace_id=([0-9a-f]{32}) span_id=([0-9a-f]{16})/u
const DROPPED_LINE = /^ {4}dropped (attributes=\d+ events=\d+ links=\d+)$/u
const BLOCK = '        '
const INDENT = '    '

/** `ok` / `✗ <type>` / `✗ <type> ERROR[: <message>]` → the status text and the `error.type`. */
const outcomeOf = (outcome: string): { status: string; type: string | null } => {
  if (outcome === 'ok') {
    return { status: 'unset', type: null }
  }

  const type = tokenAt(outcome, 2)
  const rest = outcome.slice(type.end)

  if (rest === '') {
    return { status: 'unset', type: type.text }
  }

  if (rest === ' ERROR') {
    return { status: 'error', type: type.text === 'error' ? null : type.text }
  }

  if (rest.startsWith(' ERROR: ')) {
    return {
      status: `error: ${rest.slice(' ERROR: '.length)}`,
      type: type.text === 'error' ? null : type.text,
    }
  }

  throw new Error(`stdout: an outcome I cannot read: ${outcome}`)
}

interface OpenSpan {
  readonly span: Omit<TextSpan, 'events' | 'links' | 'attributes' | 'dropped'>
  readonly attributes: Map<string, string>
  readonly events: { name: string; attributes: Map<string, string>; block: string[] }[]
  readonly links: { traceId: string; spanId: string; attributes: string[] }[]
  dropped: string
}

interface OpenLog {
  readonly log: Omit<TextLog, 'attributes' | 'body'>
  readonly attributes: Map<string, string>
  readonly body: string[]
}

const spanFrom = (line: string, match: RegExpExecArray): OpenSpan => {
  const [, service, kind, rest] = match as unknown as [string, string, string, string]
  const ids = [...rest.matchAll(IDS)][0]

  if (!ids) {
    throw new Error(`stdout: a span line without ids: ${line}`)
  }

  const head = SPAN_HEAD.exec(rest.slice(0, ids.index))

  if (!head) {
    throw new Error(`stdout: a span line I cannot read: ${line}`)
  }

  const afterIds = (ids.index ?? 0) + ids[0].length
  const parent = /^ parent_id=([0-9a-f]{16})/u.exec(rest.slice(afterIds))
  const tokens = tokensFrom(rest, afterIds + (parent?.[0].length ?? 0))

  if (!tokens) {
    throw new Error(`stdout: attributes I cannot read: ${line}`)
  }

  const outcome = outcomeOf(head[2]!)

  if (outcome.type !== null && tokens.get('error.type') !== outcome.type) {
    throw new Error(`stdout: the outcome's error type is not the attribute: ${line}`)
  }

  return {
    span: {
      traceId: ids[1]!,
      spanId: ids[2]!,
      parentId: parent?.[1] ?? null,
      name: head[1]!,
      kind,
      service,
      status: outcome.status,
    },
    attributes: tokens,
    events: [],
    links: [],
    dropped: 'attributes=0 events=0 links=0',
  }
}

const logFrom = (line: string, match: RegExpExecArray): OpenLog => {
  const [, service, severity, scope, eventName, rest] = match as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
    string,
  ]
  // the ids follow the first body line; with none, the first split whose rest reads as tokens
  const ids = [...rest.matchAll(IDS)].toReversed()

  for (const found of ids) {
    const tokens = tokensFrom(rest, (found.index ?? 0) + found[0].length)

    if (tokens) {
      return {
        log: {
          traceId: found[1]!,
          spanId: found[2]!,
          severity: severity.toUpperCase(),
          eventName: eventName ?? null,
          service,
          scope,
        },
        attributes: tokens,
        body: [rest.slice(0, found.index)],
      }
    }
  }

  for (let at = rest.indexOf(' '); at !== -1; at = rest.indexOf(' ', at + 1)) {
    const tokens = tokensFrom(rest, at)

    if (tokens) {
      return {
        log: {
          traceId: null,
          spanId: null,
          severity: severity.toUpperCase(),
          eventName: eventName ?? null,
          service,
          scope,
        },
        attributes: tokens,
        body: [rest.slice(0, at)],
      }
    }
  }

  return {
    log: {
      traceId: null,
      spanId: null,
      severity: severity.toUpperCase(),
      eventName: eventName ?? null,
      service,
      scope,
    },
    attributes: new Map(),
    body: [rest],
  }
}

/** A line under a span: an event, a line of that event's block (`exception.stacktrace`), a link
 * or the dropped counts. */
const underSpan = (open: OpenSpan, line: string): void => {
  const event = EVENT_LINE.exec(line)

  if (event) {
    const tokens = tokensFrom(line, event[0].length)

    if (!tokens) {
      throw new Error(`stdout: event attributes I cannot read: ${line}`)
    }

    open.events.push({ name: event[1]!, attributes: tokens, block: [] })
    return
  }

  const last = open.events.at(-1)

  if (line.startsWith(BLOCK) && last && open.links.length === 0) {
    last.block.push(line.slice(BLOCK.length))
    return
  }

  const link = LINK_LINE.exec(line)

  if (link) {
    const tokens = tokensFrom(line, link[0].length)

    if (!tokens) {
      throw new Error(`stdout: link attributes I cannot read: ${line}`)
    }

    open.links.push({ traceId: link[1]!, spanId: link[2]!, attributes: pairsOf(tokens) })
    return
  }

  const dropped = DROPPED_LINE.exec(line)

  if (dropped) {
    open.dropped = dropped[1]!
    return
  }

  throw new Error(`stdout: a line under a span I cannot place: ${line}`)
}

const closeSpan = (open: OpenSpan): TextSpan => ({
  ...open.span,
  attributes: pairsOf(open.attributes),
  events: open.events.map(event => {
    const attributes = new Map(event.attributes)

    // a multi-line value prints as a block under its event, never inline
    if (event.block.length > 0) {
      attributes.set('exception.stacktrace', event.block.join('\n'))
    }

    return { name: event.name, attributes: pairsOf(attributes) }
  }),
  links: open.links,
  dropped: open.dropped,
})

const closeLog = (open: OpenLog): TextLog => {
  const body = open.body.join('\n')
  const attributes = new Map(open.attributes)

  // stdout never repeats a multi-line value equal to the body: an exception record's chain IS
  // its body (std writes `exception.stacktrace` beside `exception.type` on every one)
  if (attributes.has('exception.type') && !attributes.has('exception.stacktrace')) {
    attributes.set('exception.stacktrace', body)
  }

  return { ...open.log, body, attributes: pairsOf(attributes) }
}

/** Every span and log record StdoutExporter printed (lines not its own are skipped). */
export const fromStdout = (lines: readonly string[]): Records<TextSpan, TextLog> => {
  const spans: TextSpan[] = []
  const logs: TextLog[] = []
  let open: { span: OpenSpan } | { log: OpenLog } | null = null

  const close = () => {
    if (open && 'span' in open) {
      spans.push(closeSpan(open.span))
    } else if (open) {
      logs.push(closeLog(open.log))
    }
    open = null
  }

  for (const line of lines) {
    if (line.startsWith('[oz] ')) {
      close()
      const span = SPAN_LINE.exec(line)

      if (span) {
        open = { span: spanFrom(line, span) }
        continue
      }

      const log = LOG_LINE.exec(line)

      if (!log) {
        throw new Error(`stdout: a record line I cannot read: ${line}`)
      }

      open = { log: logFrom(line, log) }
      continue
    }

    const current = open as { span: OpenSpan } | { log: OpenLog } | null

    if (current && line.startsWith(INDENT)) {
      if ('span' in current) {
        underSpan(current.span, line)
      } else {
        current.log.body.push(line.slice(INDENT.length))
      }
      continue
    }

    close()
  }

  close()

  return canonical({ spans, logs })
}
