/**
 * The OTLP encoder `OtlpExporter` and `OpenObserveExporter` share: GOLDEN OTLP/JSON for a fixed
 * set of spans and log records, and the protobuf encoding decoded back (a strict test decoder)
 * to exactly the same thing — fractional doubles, negative / 64-bit integers, arrays (empty
 * ones included), flags, ids and `event_name` survive byte-exact.
 */
import type { ObserveDef } from 'server:core'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { encodeLogs, encodeSpans } from 'server:plugins/observe/otlp'

import { attrsOf, decodeOtlp } from './otlp-wire'

const T1 = '0af7651916cd43dd8448eb211c80319c'
const T2 = '4bf92f3577b34da6a3ce929d0e0e4736'
const S0 = '00f067aa0ba902b7'
const S1 = 'b7ad6b7169203331'
const S2 = '53995c3f42cd8ad8'
const S3 = '1111111111111111'
const S4 = '2222222222222222'

const node = {
  'service.namespace': 'shop',
  'service.version': '1.2.3',
  'telemetry.sdk.name': '@ozaco/server',
}
const appResource = {
  ...node,
  'service.name': 'shop',
  'service.instance.id': 'a1b2c3d4',
} as ObserveDef.Resource
const todosResource = {
  ...node,
  'service.name': 'todos',
  'service.instance.id': 'a1b2c3d4',
} as ObserveDef.Resource

const serverScope = { name: '@ozaco/server', version: '1.0.0' }

const base = {
  service: null,
  droppedAttributes: 0,
  events: [],
  droppedEvents: 0,
  links: [],
  droppedLinks: 0,
  status: { code: 'unset' },
} as const

/** An edge SERVER span under a REMOTE parent: every field the encoder knows. */
const edgeSpan: TraceDef.SpanData = {
  ...base,
  context: { traceId: T1, spanId: S1, flags: 3, state: 'ozaco=1' },
  parent: { traceId: T1, spanId: S0, flags: 1, remote: true },
  name: 'GET /todos/:id',
  kind: 'server',
  scope: serverScope,
  start: 1_700_000_000_000.25,
  end: 1_700_000_000_012.5,
  attributes: {
    'http.request.method': 'GET',
    'http.response.status_code': 500,
    'http.route': '/todos/:id',
    'ozaco.ratio': 1.5,
    'ozaco.tags': ['a', 'b'],
    'ozaco.ids': [1, 2],
    'ozaco.flags': [true, false],
    'ozaco.none': [],
    'ozaco.delta': -5,
    'ozaco.big': 2 ** 60,
    user_id: 'u-1',
  },
  droppedAttributes: 2,
  events: [
    {
      name: 'exception',
      time: 1_700_000_000_010,
      attributes: { 'exception.type': 'TypeError', 'exception.message': 'bad' },
    },
  ],
  links: [
    {
      context: { traceId: T2, spanId: S2, flags: 1, remote: true },
      attributes: { 'ozaco.link.reason': 'remote.parent' },
    },
  ],
  droppedLinks: 1,
  status: { code: 'error', message: 'bad' },
}

/** A local INTERNAL child, per-service resource. */
const dispatchSpan: TraceDef.SpanData = {
  ...base,
  context: { traceId: T1, spanId: S3, flags: 3 },
  parent: { traceId: T1, spanId: S1, flags: 3 },
  name: 'todos.get',
  kind: 'internal',
  service: 'todos',
  scope: serverScope,
  start: 1_700_000_000_001,
  end: 1_700_000_000_009,
  attributes: { 'code.function.name': 'todos.get' },
}

/** Another scope under the same resource. */
const dbSpan: TraceDef.SpanData = {
  ...base,
  context: { traceId: T1, spanId: S4, flags: 3 },
  parent: { traceId: T1, spanId: S3, flags: 3 },
  name: 'select todos',
  kind: 'client',
  service: 'todos',
  scope: { name: '@ozaco/db' },
  start: 1_700_000_000_002,
  end: 1_700_000_000_003,
  attributes: { 'db.system.name': 'ozaco.memory', 'db.namespace': 'memory' },
}

const spanEvents: ObserveDef.Event[] = [
  { t: 'span', span: dispatchSpan, resource: todosResource },
  { t: 'span', span: edgeSpan, resource: appResource },
  { t: 'span', span: dbSpan, resource: todosResource },
]

const logBase = { droppedAttributes: 0, service: null } as const

const exceptionLog: TraceDef.LogData = {
  ...logBase,
  time: 1_700_000_000_010,
  observedTime: 1_700_000_000_011,
  severityNumber: 17,
  body: 'TypeError: bad',
  eventName: 'http.server.request.exception',
  attributes: {
    'exception.type': 'TypeError',
    'exception.message': 'bad',
    'ozaco.failure.chain': ['TypeError: bad'],
    'otel.event.name': 'http.server.request.exception',
  },
  context: { traceId: T1, spanId: S1, flags: 3 },
  scope: serverScope,
}

const loggerLog: TraceDef.LogData = {
  ...logBase,
  time: 1_700_000_000_020.5,
  observedTime: 1_700_000_000_021,
  severityNumber: 9,
  severityText: 'INFO',
  body: 'hello',
  attributes: { 'ozaco.count': 3 },
  context: null,
  scope: { name: '@ozaco/std/logger', version: '9.9.9' },
}

/** In an UNSAMPLED trace: ids ride, flags 00 are left out. */
const unsampledLog: TraceDef.LogData = {
  ...logBase,
  time: 1_700_000_000_030,
  observedTime: 1_700_000_000_030,
  severityNumber: 13,
  severityText: 'WARN',
  body: 'careful',
  attributes: {},
  context: { traceId: T2, spanId: S2, flags: 0 },
  scope: { name: '@ozaco/std/logger' },
}

const logEvents: ObserveDef.Event[] = [
  { t: 'log', log: exceptionLog, resource: appResource },
  { t: 'log', log: loggerLog, resource: todosResource },
  { t: 'log', log: unsampledLog, resource: appResource },
]

const spansOnly = (events: readonly ObserveDef.Event[]) =>
  events.filter((event): event is Extract<ObserveDef.Event, { t: 'span' }> => event.t === 'span')
const logsOnly = (events: readonly ObserveDef.Event[]) =>
  events.filter((event): event is Extract<ObserveDef.Event, { t: 'log' }> => event.t === 'log')

const str = (value: string) => ({ stringValue: value })
const int = (value: number | string) => ({ intValue: String(value) })
const kv = (key: string, value: AnyType) => ({ key, value })

const nodeAttributes = [
  kv('service.namespace', str('shop')),
  kv('service.version', str('1.2.3')),
  kv('telemetry.sdk.name', str('@ozaco/server')),
]

const GOLDEN_TRACES = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          ...nodeAttributes,
          kv('service.name', str('todos')),
          kv('service.instance.id', str('a1b2c3d4')),
        ],
      },
      scopeSpans: [
        {
          scope: { name: '@ozaco/server', version: '1.0.0' },
          spans: [
            {
              traceId: T1,
              spanId: S3,
              parentSpanId: S1,
              flags: 0x1_03,
              name: 'todos.get',
              kind: 1,
              startTimeUnixNano: '1700000000001000000',
              endTimeUnixNano: '1700000000009000000',
              attributes: [kv('code.function.name', str('todos.get'))],
            },
          ],
        },
        {
          scope: { name: '@ozaco/db' },
          spans: [
            {
              traceId: T1,
              spanId: S4,
              parentSpanId: S3,
              flags: 0x1_03,
              name: 'select todos',
              kind: 3,
              startTimeUnixNano: '1700000000002000000',
              endTimeUnixNano: '1700000000003000000',
              attributes: [
                kv('db.system.name', str('ozaco.memory')),
                kv('db.namespace', str('memory')),
              ],
            },
          ],
        },
      ],
    },
    {
      resource: {
        attributes: [
          ...nodeAttributes,
          kv('service.name', str('shop')),
          kv('service.instance.id', str('a1b2c3d4')),
        ],
      },
      scopeSpans: [
        {
          scope: { name: '@ozaco/server', version: '1.0.0' },
          spans: [
            {
              traceId: T1,
              spanId: S1,
              traceState: 'ozaco=1',
              parentSpanId: S0,
              // has-is-remote + is-remote (the parent came over the wire) + sampled|random
              flags: 0x3_03,
              name: 'GET /todos/:id',
              kind: 2,
              startTimeUnixNano: '1700000000000250000',
              endTimeUnixNano: '1700000000012500000',
              attributes: [
                kv('http.request.method', str('GET')),
                kv('http.response.status_code', int(500)),
                kv('http.route', str('/todos/:id')),
                kv('ozaco.ratio', { doubleValue: 1.5 }),
                kv('ozaco.tags', { arrayValue: { values: [str('a'), str('b')] } }),
                kv('ozaco.ids', { arrayValue: { values: [int(1), int(2)] } }),
                kv('ozaco.flags', {
                  arrayValue: { values: [{ boolValue: true }, { boolValue: false }] },
                }),
                kv('ozaco.none', { arrayValue: { values: [] } }),
                kv('ozaco.delta', int(-5)),
                kv('ozaco.big', int('1152921504606846976')),
                // attribute keys are NEVER transformed (no camelCase)
                kv('user_id', str('u-1')),
              ],
              droppedAttributesCount: 2,
              events: [
                {
                  timeUnixNano: '1700000000010000000',
                  name: 'exception',
                  attributes: [
                    kv('exception.type', str('TypeError')),
                    kv('exception.message', str('bad')),
                  ],
                },
              ],
              links: [
                {
                  traceId: T2,
                  spanId: S2,
                  attributes: [kv('ozaco.link.reason', str('remote.parent'))],
                  flags: 0x3_01,
                },
              ],
              droppedLinksCount: 1,
              status: { message: 'bad', code: 2 },
            },
          ],
        },
      ],
    },
  ],
}

const GOLDEN_LOGS = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          ...nodeAttributes,
          kv('service.name', str('shop')),
          kv('service.instance.id', str('a1b2c3d4')),
        ],
      },
      scopeLogs: [
        {
          scope: { name: '@ozaco/server', version: '1.0.0' },
          logRecords: [
            {
              timeUnixNano: '1700000000010000000',
              severityNumber: 17,
              body: str('TypeError: bad'),
              attributes: [
                kv('exception.type', str('TypeError')),
                kv('exception.message', str('bad')),
                kv('ozaco.failure.chain', { arrayValue: { values: [str('TypeError: bad')] } }),
                kv('otel.event.name', str('http.server.request.exception')),
              ],
              flags: 3,
              traceId: T1,
              spanId: S1,
              observedTimeUnixNano: '1700000000011000000',
              eventName: 'http.server.request.exception',
            },
          ],
        },
        {
          scope: { name: '@ozaco/std/logger' },
          logRecords: [
            {
              timeUnixNano: '1700000000030000000',
              severityNumber: 13,
              severityText: 'WARN',
              body: str('careful'),
              traceId: T2,
              spanId: S2,
              observedTimeUnixNano: '1700000000030000000',
            },
          ],
        },
      ],
    },
    {
      resource: {
        attributes: [
          ...nodeAttributes,
          kv('service.name', str('todos')),
          kv('service.instance.id', str('a1b2c3d4')),
        ],
      },
      scopeLogs: [
        {
          scope: { name: '@ozaco/std/logger', version: '9.9.9' },
          logRecords: [
            {
              timeUnixNano: '1700000000020500000',
              severityNumber: 9,
              severityText: 'INFO',
              body: str('hello'),
              attributes: [kv('ozaco.count', int(3))],
              observedTimeUnixNano: '1700000000021000000',
            },
          ],
        },
      ],
    },
  ],
}

const jsonOf = (encoded: { body: Uint8Array | string }) => JSON.parse(encoded.body as string)

const contains = (haystack: Uint8Array, needle: readonly number[]): boolean =>
  Buffer.from(haystack).includes(Buffer.from(needle))

describe('observe/otlp — encoder (golden OTLP/JSON)', () => {
  it('spans: one resource block per (service.name, instance), one scope block per scope', () => {
    const encoded = encodeSpans(spansOnly(spanEvents), { encoding: 'json' })

    expect(encoded.contentType).toBe('application/json')
    expect(encoded.items).toBe(3)
    expect(jsonOf(encoded)).toEqual(GOLDEN_TRACES)
  })

  it('logs: severity text only when bridged, flags only when set, eventName kept', () => {
    const encoded = encodeLogs(logsOnly(logEvents), { encoding: 'json' })

    expect(encoded.contentType).toBe('application/json')
    expect(jsonOf(encoded)).toEqual(GOLDEN_LOGS)
  })

  it('a base `resource` sits UNDER the event resource', () => {
    const encoded = encodeSpans(spansOnly(spanEvents).slice(0, 1), {
      encoding: 'json',
      resource: { 'deployment.environment.name': 'prod', 'service.name': 'from-env' },
    })
    const resource = jsonOf(encoded).resourceSpans[0].resource

    expect(attrsOf(resource)).toEqual({
      'deployment.environment.name': 'prod',
      // the event's own resource wins
      'service.name': 'todos',
      'service.namespace': 'shop',
      'service.version': '1.2.3',
      'telemetry.sdk.name': '@ozaco/server',
      'service.instance.id': 'a1b2c3d4',
    })
  })

  it('a log record ships exactly as the kernel reported it — the kernel budgets, the encoder never cuts again', () => {
    const many: Record<string, TraceDef.AttrValue> = { 'exception.type': 'x.y' }

    for (let index = 0; index < 150; index += 1) {
      many[`ozaco.field_${index}`] = index
    }

    const huge: Record<string, TraceDef.AttrValue> = {
      'exception.type': 'x.y',
      'ozaco.blob_a': 'a'.repeat(30 * 1024),
      'ozaco.blob_b': 'b'.repeat(30 * 1024),
    }

    const events: ObserveDef.Event[] = [
      {
        t: 'log',
        log: { ...loggerLog, attributes: many, droppedAttributes: 1 },
        resource: todosResource,
      },
      { t: 'log', log: { ...loggerLog, attributes: huge }, resource: todosResource },
    ]

    for (const encoding of ['json', 'protobuf'] as const) {
      const encoded = encodeLogs(logsOnly(events), { encoding })
      const payload =
        encoding === 'json' ? jsonOf(encoded) : decodeOtlp('logs', encoded.body as Uint8Array)
      const [first, second] = payload.resourceLogs[0].scopeLogs[0].logRecords

      expect(first.attributes).toHaveLength(151)
      expect(first.droppedAttributesCount).toBe(1)
      expect(attrsOf(second)).toEqual(huge)
      expect(second.droppedAttributesCount).toBeUndefined()
    }
  })
})

describe('observe/otlp — encoder (protobuf)', () => {
  it('decodes to exactly the OTLP/JSON encoding (spans)', () => {
    const encoded = encodeSpans(spansOnly(spanEvents))

    expect(encoded.contentType).toBe('application/x-protobuf')
    expect(encoded.body).toBeInstanceOf(Uint8Array)
    expect(decodeOtlp('traces', encoded.body as Uint8Array)).toEqual(GOLDEN_TRACES)
  })

  it('decodes to exactly the OTLP/JSON encoding (logs)', () => {
    const encoded = encodeLogs(logsOnly(logEvents), { encoding: 'protobuf' })

    expect(encoded.contentType).toBe('application/x-protobuf')
    expect(decodeOtlp('logs', encoded.body as Uint8Array)).toEqual(GOLDEN_LOGS)
  })

  it('writes the wire bytes opentelemetry-proto defines', () => {
    const traces = encodeSpans(spansOnly(spanEvents)).body as Uint8Array
    const logs = encodeLogs(logsOnly(logEvents)).body as Uint8Array
    const f64 = (value: number) => {
      const bytes = new Uint8Array(8)
      new DataView(bytes.buffer).setFloat64(0, value, true)
      return [...bytes]
    }
    const u64 = (value: bigint) => {
      const bytes = new Uint8Array(8)
      new DataView(bytes.buffer).setBigUint64(0, value, true)
      return [...bytes]
    }

    // AnyValue.double_value (4, fixed64) = 1.5 — the fractional double OTLP/JSON loses to
    // OpenObserve travels as IEEE-754 bits
    expect(contains(traces, [0x21, ...f64(1.5)])).toBe(true)
    // AnyValue.int_value (3, varint) = -5: a 10-byte two's complement varint
    expect(
      contains(traces, [0x18, 0xfb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    ).toBe(true)
    // Span.start_time_unix_nano (7, fixed64)
    expect(contains(traces, [0x39, ...u64(1_700_000_000_000_250_000n)])).toBe(true)
    // Span.flags (16, fixed32) = 0x303
    expect(contains(traces, [0x85, 0x01, 0x03, 0x03, 0x00, 0x00])).toBe(true)
    // Span.trace_id (1, bytes[16])
    expect(contains(traces, [0x0a, 0x10, ...Buffer.from(T1, 'hex')])).toBe(true)
    // LogRecord.event_name (12, string)
    const name = [...new TextEncoder().encode('http.server.request.exception')]
    expect(contains(logs, [0x62, name.length, ...name])).toBe(true)
  })
})
