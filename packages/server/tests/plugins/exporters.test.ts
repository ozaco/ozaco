/**
 * `ObserveExporter`: destinations run SIDE BY SIDE — the kernel fans every event out to all
 * installs (nested ones included), starts them with the node and flushes them at stop; they
 * work with or without the `ObservePlugin` store. Every sink holds EXACTLY the same data: a
 * memory exporter, stdout, OTLP/JSON and OpenObserve (OTLP/protobuf) decode to identical spans
 * and log records.
 */
import type { ObserveDef } from 'server:core'
import { action, createServer, ObserveExporter, Server, service } from 'server:core'
import { StdoutExporter } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, run, sleep } from 'std:effect'
import { asFailure, fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { emitLog } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { OpenObserveExporter } from 'server:plugins/observe/openobserve'
import { encodeLogs, encodeSpans, OtlpExporter } from 'server:plugins/observe/otlp'
import { z } from 'zod'

import { storage, todos } from '../helpers'

import { attrOf, attrsOf, fakeCollector, payloadOf } from './otlp-wire'

/** A destination of one's own: every event lands in an array, flushes are counted. */
const memoryExporter = () => {
  const seen: ObserveDef.Event[] = []
  const lifecycle = { started: 0, flushed: 0 }
  const Impl = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: 'test-observe-memory',
    version: '0.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  })
  const plugin = Impl.build({
    *export(event: ObserveDef.Event) {
      seen.push(event)
    },
    *start() {
      lifecycle.started += 1
    },
    *flush() {
      lifecycle.flushed += 1
    },
  })
  return { plugin, seen, lifecycle }
}

/** `console.log` captured while `body` runs. */
const captureStdout = async <T>(body: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(...args.map(String).join(' ').split('\n'))
  }

  try {
    return { value: await body(), lines }
  } finally {
    console.log = original
  }
}

/** A failure three levels deep, the innermost a thrown TypeError's fold. */
const chain = service('chain', {
  deep: action.query({ input: z.object({}) }, function* ({ ctx }) {
    yield* ctx.log.warn('about to break', { 'ozaco.step': 3 })
    const inner = asFailure(new TypeError('inner type error'))

    return yield* fail('deep.broken', 'outer broke', fail('deep.middle', 'middle failed', inner))
  }),
})

/** A local root with an event and a link to an earlier span. */
function* linkedRoot(context: { traceId: string; spanId: string }): Operation<void> {
  yield* Server.actions.span(
    'job run',
    function* (span) {
      span.addEvent('ozaco.job.step', { 'ozaco.job.n': 1 })
    },
    {
      parent: null,
      links: [
        { context: { ...context, flags: 1 }, attributes: { 'ozaco.link.reason': 'creation' } },
      ],
    },
  )
}

type SpanEvent = Extract<ObserveDef.Event, { t: 'span' }>
type LogEvent = Extract<ObserveDef.Event, { t: 'log' }>

/** 150 attributes: over the kernel's log budget (std itself keeps 128). */
const wideAttributes = (): Record<string, number> =>
  Object.fromEntries(Array.from({ length: 150 }, (_, at) => [`ozaco.wide_${at}`, at]))

/** A kernel log record, reduced to what every sink must agree on. */
const rawLogOf = (event: LogEvent): string =>
  JSON.stringify({
    body: event.log.body,
    severity: event.log.severityNumber,
    eventName: event.log.eventName ?? null,
    traceId: event.log.context?.traceId ?? null,
    spanId: event.log.context?.spanId ?? null,
    service: event.resource['service.name'],
    attributes: event.log.attributes,
    dropped: event.log.droppedAttributes,
  })

/** The same reduction of every log record an OTLP payload carries. */
const wireLogsOf = (payload: AnyType): string[] =>
  (payload.resourceLogs ?? []).flatMap((block: AnyType) =>
    block.scopeLogs.flatMap((scope: AnyType) =>
      scope.logRecords.map((record: AnyType) =>
        JSON.stringify({
          body: record.body.stringValue,
          severity: record.severityNumber ?? 0,
          eventName: record.eventName ?? null,
          traceId: record.traceId || null,
          spanId: record.spanId || null,
          service: attrOf(block.resource, 'service.name'),
          attributes: attrsOf(record),
          dropped: record.droppedAttributesCount ?? 0,
        }),
      ),
    ),
  )

/** Every span / log record of an OTLP/JSON(-shaped) payload list, flattened with its resource
 * service name. */
const flatSpans = (payloads: readonly AnyType[]): Map<string, AnyType> =>
  new Map(
    payloads.flatMap(payload =>
      (payload.resourceSpans ?? []).flatMap((block: AnyType) =>
        block.scopeSpans.flatMap((scope: AnyType) =>
          scope.spans.map((span: AnyType) => [
            span.spanId,
            { ...span, resource: block.resource, scope: scope.scope },
          ]),
        ),
      ),
    ),
  )

const flatLogs = (payloads: readonly AnyType[]): string[] =>
  payloads
    .flatMap(payload =>
      (payload.resourceLogs ?? []).flatMap((block: AnyType) =>
        block.scopeLogs.flatMap((scope: AnyType) =>
          scope.logRecords.map((record: AnyType) =>
            JSON.stringify({ ...record, resource: block.resource, scope: scope.scope }),
          ),
        ),
      ),
    )
    .toSorted()

describe('observe exporters', () => {
  it('several exporters see every event, start with the node and flush at stop — no store needed', async () => {
    const memory = memoryExporter()
    const collector = fakeCollector()

    const { lines } = await captureStdout(async () =>
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos],
            plugins: [
              memory.plugin,
              StdoutExporter,
              OtlpExporter.use({
                url: 'http://collector:4318',
                fetch: collector.fetch,
                batch: { waitMs: 10 },
              }),
            ],
          })
          yield* server.start()
          expect(memory.lifecycle.started).toBe(1)
          yield* server.call(todos, 'create', { title: 'shipped' })
          yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
          yield* sleep(40)
          // a failure is no event kind of its own: it is the exception LogData of its span
          expect(
            memory.seen.some(
              event => event.t === 'log' && event.log.eventName === 'ozaco.action.exception',
            ),
          ).toBe(true)
          expect(collector.of('/v1/traces').length).toBeGreaterThan(0)
          yield* server.stop()
          expect(memory.lifecycle.flushed).toBe(1)
        }),
      ),
    )

    // stdout: every span a line with its ids, the outcome readable at a glance
    const create = lines.find(line => line.includes(' todos.create '))
    expect(create).toMatch(
      / INTERNAL todos\.create [\d.]+ms ok trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16}/u,
    )
    expect(create).toContain('code.function.name=todos.create')
    expect(
      lines.some(
        line => line.includes(' todos.explode ') && line.includes('✗ x.y ERROR: boom x.y'),
      ),
    ).toBe(true)
  })

  it('stdout: spans with their events and links indented, exceptions with the full chain', async () => {
    const memory = memoryExporter()

    const { lines } = await captureStdout(async () =>
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos, chain],
            name: 'stdout-demo',
            plugins: [memory.plugin, StdoutExporter],
          })
          yield* server.start()
          yield* attempt(server.call(chain, 'deep', {}))
          const first = memory.seen.find((event): event is SpanEvent => event.t === 'span')!
          yield* linkedRoot(first.span.context)
          yield* server.stop()
        }),
      ),
    )

    // the failing dispatch: status error, the exception EVENT indented under it (no stacktrace
    // there — the log record carries the chain once, in full)
    const at = lines.findIndex(line => line.includes(' chain.deep ') && line.includes('span_id='))
    expect(lines[at]).toContain('✗ deep.broken ERROR: outer broke')
    expect(lines[at + 1]).toMatch(/^ {4}· \S+ \+[\d.]+ms exception exception\.type=deep\.broken/u)
    expect(lines[at + 1]).not.toContain('exception.stacktrace')

    // the exception record: severity, event name, ids — then the chain, innermost included
    const record = lines.findIndex(line => line.includes('[ozaco.action.exception]'))
    expect(lines[record]).toMatch(
      / ERROR @ozaco\/server \[ozaco\.action\.exception\] deep\.broken: outer broke trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16}/u,
    )
    const block = lines.slice(record + 1).filter(line => line.startsWith('    '))
    expect(block.some(line => line.includes('Caused by: deep.middle: middle failed'))).toBe(true)
    expect(
      block.some(line =>
        line.includes('Caused by: std:result.unknown: TypeError: inner type error'),
      ),
    ).toBe(true)

    // the handler's own line, correlated
    expect(
      lines.some(line => /WARN @ozaco\/server about to break trace_id=[0-9a-f]{32}/u.test(line)),
    ).toBe(true)

    // the linked root: its event and its link, indented
    const job = lines.findIndex(line => line.includes(' job run '))
    expect(lines[job + 1]).toMatch(/^ {4}· .* ozaco\.job\.step ozaco\.job\.n=1$/u)
    expect(lines[job + 2]).toMatch(
      /^ {4}↗ link trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16} ozaco\.link\.reason=creation$/u,
    )
  })

  it('stdout prints every value as recorded: NaN / Infinity are the strings std made them, never null', async () => {
    const odd = service('odd', {
      go: action.query({}, function* ({ ctx }) {
        yield* ctx.span('odd values', function* () {}, {
          attributes: {
            'ozaco.ratio': Number.NaN,
            'ozaco.limit': Number.POSITIVE_INFINITY,
            'ozaco.points': [1.5, Number.NEGATIVE_INFINITY],
            'ozaco.tags': ['a b', 'c'],
          },
        })
        return 'ok'
      }),
    })

    const { lines } = await captureStdout(async () =>
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({ services: [odd], plugins: [StdoutExporter] })
          yield* server.start()
          yield* server.call(odd, 'go', {})
          yield* server.stop()
        }),
      ),
    )

    const line = lines.find(entry => entry.includes(' odd values '))
    // std spells non-finite numbers out as strings once, before any sink (a mixed array turns
    // into strings): stdout prints them as every other sink holds them
    expect(line).toContain('ozaco.ratio=NaN')
    expect(line).toContain('ozaco.limit=Infinity')
    expect(line).toContain('ozaco.points=["1.5","-Infinity"]')
    expect(line).toContain('ozaco.tags=["a b","c"]')
  })

  it('SINK PARITY: memory, stdout, OTLP/JSON and OpenObserve (protobuf) hold the same spans and log records', async () => {
    const memory = memoryExporter()
    const json = fakeCollector()
    const protobuf = fakeCollector()

    const { lines } = await captureStdout(async () =>
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos, chain],
            name: 'parity',
            plugins: [
              memory.plugin,
              StdoutExporter,
              OtlpExporter.use({
                url: 'http://collector:4318',
                encoding: 'json',
                fetch: json.fetch,
                batch: { size: 3, waitMs: 10 },
                metrics: false,
              }),
              // side by side with an OtlpExporter: neither replaces the other
              OpenObserveExporter.use({
                url: 'http://openobserve:5080',
                auth: { user: 'root', pass: 'pw' },
                fetch: protobuf.fetch,
                batch: { size: 7, waitMs: 10 },
                metrics: false,
              }),
            ],
          })
          yield* server.start()
          yield* server.call(todos, 'create', { title: 'one' })
          yield* server.call(todos, 'nested', { title: 'two' })
          yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
          yield* attempt(server.call(chain, 'deep', {}))
          yield* Server.actions.report({ stream: 'audit', verb: 'todo.checked', ratio: 0.25 })
          // a record over the log budget (> 96 attributes): cut ONCE, by the kernel
          yield* emitLog({ body: 'wide record', severityNumber: 9, attributes: wideAttributes() })
          const first = memory.seen.find((event): event is SpanEvent => event.t === 'span')!
          yield* linkedRoot(first.span.context)
          yield* server.stop()
        }),
      ),
    )

    const spanEvents = memory.seen.filter((event): event is SpanEvent => event.t === 'span')
    const logEvents = memory.seen.filter((event): event is LogEvent => event.t === 'log')
    expect(spanEvents.length).toBeGreaterThan(5)
    expect(logEvents.length).toBeGreaterThan(3)

    // the custom exporter got the budgeted record, like every other sink
    const wide = logEvents.find(event => event.log.body === 'wide record')!.log
    expect(Object.keys(wide.attributes)).toHaveLength(96)
    expect(wide.droppedAttributes).toBe(150 - 96)

    // the log records as the KERNEL reported them (no encoder in between) vs what each OTLP
    // leg shipped: the same set — attributes, dropped counts, ids, event names, severities
    const rawLogs = logEvents.map(event => rawLogOf(event)).toSorted()
    expect(
      json
        .of('/v1/logs')
        .flatMap(entry => wireLogsOf(payloadOf(entry)))
        .toSorted(),
    ).toEqual(rawLogs)
    expect(
      protobuf
        .of('/v1/logs')
        .flatMap(entry => wireLogsOf(payloadOf(entry)))
        .toSorted(),
    ).toEqual(rawLogs)

    // what the memory exporter holds, encoded — the reference for the full OTLP shape
    const reference = flatSpans([
      JSON.parse(encodeSpans(spanEvents, { encoding: 'json' }).body as string),
    ])
    const referenceLogs = flatLogs([
      JSON.parse(encodeLogs(logEvents, { encoding: 'json' }).body as string),
    ])

    const viaJson = flatSpans(json.of('/v1/traces').map(payloadOf))
    const viaProtobuf = flatSpans(protobuf.of('/v1/traces').map(payloadOf))

    // the two OTLP legs really went out in their own encodings
    expect(json.of('/v1/traces')[0]!.headers['content-type']).toBe('application/json')
    expect(protobuf.of('/v1/traces')[0]!.headers['content-type']).toBe('application/x-protobuf')

    expect([...viaJson.keys()].toSorted()).toEqual([...reference.keys()].toSorted())
    expect([...viaProtobuf.keys()].toSorted()).toEqual([...reference.keys()].toSorted())

    for (const [id, span] of reference) {
      expect(viaJson.get(id)).toEqual(span)
      expect(viaProtobuf.get(id)).toEqual(span)
    }

    expect(flatLogs(json.of('/v1/logs').map(payloadOf))).toEqual(referenceLogs)
    expect(flatLogs(protobuf.of('/v1/logs').map(payloadOf))).toEqual(referenceLogs)

    // stdout printed every one of them
    for (const event of spanEvents) {
      expect(lines.some(line => line.includes(`span_id=${event.span.context.spanId}`))).toBe(true)
    }

    for (const event of logEvents) {
      const [head] = event.log.body.split('\n')
      expect(lines.some(line => line.includes(head!))).toBe(true)
    }
  })

  it('an exporter installed INSIDE another one is fanned out to directly (no relay)', async () => {
    const inner = memoryExporter()
    const Outer = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
      name: 'test-observe-outer',
      version: '0.0.0',
      *setup() {
        yield* inner.plugin.use()
        return { exporter: 'outer' }
      },
    }).build({
      *export() {},
      *start() {},
      *flush() {},
    })
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos], plugins: [Outer] })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'nested' })
        yield* sleep(20)
        expect(inner.lifecycle.started).toBe(1)
        expect(inner.seen.length).toBeGreaterThan(0)
        yield* server.stop()
        expect(inner.lifecycle.flushed).toBe(1)
      }),
    )
  })

  it('with no exporter installed nothing is captured for one', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos] })
        yield* server.start()
        expect((server as AnyType).exporting ?? false).toBe(false)
        yield* server.stop()
      }),
    )
  })
})
