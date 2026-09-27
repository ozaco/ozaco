/**
 * `OtlpExporter`: the kernel's spans and log records over OTLP/HTTP — protobuf by default, JSON
 * on request, the SAME content either way — plus the metrics derived from them; a transport that
 * retries what is worth retrying, times out, counts `partialSuccess`, gzips on request and
 * complains once per failure streak (never as telemetry, never into a request).
 */
import type { ObserveDef } from 'server:core'
import { createServer, ObserveExporter, Server } from 'server:core'
import { createSink } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, run, sleep, spawn, until } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { OtlpExporter } from 'server:plugins/observe/otlp'

import pkg from '../../package.json'
import { storage, todos } from '../helpers'

import { attrOf, attrsOf, fakeCollector } from './otlp-wire'

const SEMCONV_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]

const CONTENT_TYPE = { protobuf: 'application/x-protobuf', json: 'application/json' } as const

/** A Logger transport that keeps every entry. */
const captureLogger = () => {
  const entries: LoggerDef.Entry[] = []
  const impl = LoggerTransport.implement<{ name: string; level: LogLevel }, []>({
    name: 'test/otlp-capture',
    version: '1.0.0',
    *setup() {
      return { name: 'capture', level: LogLevel.trace }
    },
  })
  const transport = impl.build({
    *write(entry: LoggerDef.Entry) {
      entries.push(entry)
    },
    *flush() {},
    *close() {},
  })

  return { transport, entries }
}

/** An exporter of one's own that keeps every event (what the kernel handed the sinks). */
const memoryExporter = () => {
  const seen: ObserveDef.Event[] = []
  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: 'test/otlp-memory',
    version: '1.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      seen.push(event)
    },
    *start() {},
    *flush() {},
  })

  return { plugin, seen }
}

describe('observe/otlp — content', () => {
  it.each(['protobuf', 'json'] as const)(
    'ships spans and log records (%s) under per-service resources',
    async encoding => {
      const collector = fakeCollector()

      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos],
            name: 'otlp-demo',
            plugins: [
              OtlpExporter.use({
                url: 'http://collector:4318/',
                fetch: collector.fetch,
                batch: { waitMs: 20 },
                metrics: false,
                ...(encoding === 'json' ? { encoding } : {}),
              }),
            ],
          })
          yield* server.start()
          yield* server.call(todos, 'create', { title: 'traced' })
          yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
          yield* sleep(80)
          yield* server.stop()
        }),
      )

      // transport: the signal paths, the encoding's content type, our user agent
      expect(collector.received.length).toBeGreaterThan(0)

      for (const entry of collector.received) {
        expect(entry.url).toMatch(/^http:\/\/collector:4318\/v1\/(traces|logs)$/u)
        expect(entry.headers['content-type']).toBe(CONTENT_TYPE[encoding])
        expect(entry.headers['user-agent']).toBe(`ozaco-otlp-exporter-js/${pkg.version}`)
      }

      const spans = collector.spans()
      const create = spans.find(span => span.name === 'todos.create')
      const explode = spans.find(span => span.name === 'todos.explode')

      // the dispatch span: its OWN resource (service.name = the ozaco service), INTERNAL,
      // status omitted (unset is never an explicit ok)
      expect(create).toMatchObject({ $service: 'todos', $scope: '@ozaco/server', kind: 1 })
      expect(create.traceId).toMatch(/^[0-9a-f]{32}$/u)
      expect(create.spanId).toMatch(/^[0-9a-f]{16}$/u)
      expect(create.status).toBeUndefined()
      expect(attrOf(create, 'code.function.name')).toBe('todos.create')

      // a failure: status error with its message, `error.type`, ONE exception event
      expect(explode.status).toEqual({ code: 2, message: 'boom x.y' })
      expect(attrOf(explode, 'error.type')).toBe('x.y')
      expect(explode.events.map((event: AnyType) => event.name)).toEqual(['exception'])
      expect(attrOf(explode.events[0], 'exception.type')).toBe('x.y')

      // the log records: the handler's line on its dispatch span, the exception record
      const logs = collector.logs()
      const creating = logs.find(record => record.body.stringValue === 'creating')
      expect(creating).toMatchObject({ severityNumber: 9, severityText: 'INFO', $service: 'todos' })
      expect(creating.traceId).toBe(create.traceId)
      expect(creating.spanId).toBe(create.spanId)

      const exception = logs.find(record => record.eventName === 'ozaco.action.exception')
      expect(exception).toMatchObject({ severityNumber: 17, traceId: explode.traceId })
      expect(exception.severityText).toBeUndefined()
      expect(exception.body.stringValue).toContain('boom x.y')
      expect(attrOf(exception, 'exception.type')).toBe('x.y')
      expect(attrOf(exception, 'otel.event.name')).toBe('ozaco.action.exception')
    },
  )

  it('one resource block per (service.name, instance): node attributes + OTEL_RESOURCE_ATTRIBUTES', async () => {
    const collector = fakeCollector()
    const previous = process.env['OTEL_RESOURCE_ATTRIBUTES']
    process.env['OTEL_RESOURCE_ATTRIBUTES'] =
      'deployment.environment.name=staging,service.namespace=from-env,team=a%20b,broken'

    try {
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos],
            name: 'otlp-res',
            version: '2.0.0',
            instance: 'node-1',
            plugins: [
              OtlpExporter.use({
                url: 'http://collector:4318',
                fetch: collector.fetch,
                encoding: 'json',
                batch: { waitMs: 10 },
                metrics: false,
              }),
            ],
          })
          yield* server.start()
          yield* server.call(todos, 'create', { title: 'resourced' })
          yield* server.stop()
        }),
      )
    } finally {
      if (previous === undefined) {
        delete process.env['OTEL_RESOURCE_ATTRIBUTES']
      } else {
        process.env['OTEL_RESOURCE_ATTRIBUTES'] = previous
      }
    }

    const blocks = collector
      .of('/v1/traces')
      .flatMap(entry => JSON.parse(new TextDecoder().decode(entry.body)).resourceSpans)
    const todosBlock = blocks.find(
      (block: AnyType) => attrOf(block.resource, 'service.name') === 'todos',
    )

    expect(attrsOf(todosBlock.resource)).toMatchObject({
      'service.name': 'todos',
      'service.instance.id': 'node-1',
      // the kernel's own resource wins over the environment's
      'service.namespace': 'otlp-res',
      'service.version': '2.0.0',
      'telemetry.sdk.name': '@ozaco/server',
      'telemetry.sdk.language': 'nodejs',
      'ozaco.carrier.name': expect.any(String),
      'deployment.environment.name': 'staging',
      team: 'a b',
    })
    // one block per resource: no service name twice
    const names = blocks.map((block: AnyType) => attrOf(block.resource, 'service.name'))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('observe/otlp — metrics', () => {
  it.each(['protobuf', 'json'] as const)(
    'derives the semconv metrics (%s) from the recorded spans — seconds, allowlisted attributes',
    async encoding => {
      const collector = fakeCollector()

      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos],
            name: 'otlp-metrics',
            edge: BunEdge,
            plugins: [
              OtlpExporter.use({
                url: 'http://collector:4318',
                fetch: collector.fetch,
                encoding,
                batch: { waitMs: 10 },
                metrics: { intervalMs: 60_000 },
              }),
            ],
          })
          const info = yield* server.start({ port: 0 })
          const created = yield* until(
            fetch(`${info.url!}/todos/create`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'metered' }),
            }),
          )
          expect(created.status).toBe(200)
          const exploded = yield* until(fetch(`${info.url!}/todos/explode?code=x.y`))
          expect(exploded.status).toBe(500)
          // stop flushes: the final metrics export
          yield* server.stop()
        }),
      )

      const metrics = collector.metrics()
      const byName = (name: string, service?: string) =>
        metrics.filter(
          metric => metric.name === name && (service === undefined || metric.$service === service),
        )

      // the old ozaco request metrics are gone
      for (const gone of [
        'ozaco.requests',
        'ozaco.request.duration',
        'ozaco.failures',
        'ozaco.inflight',
        'ozaco.up',
      ]) {
        expect(byName(gone)).toHaveLength(0)
      }

      // http.server.request.duration: the EDGE spans (the node's resource), seconds
      const [http] = byName('http.server.request.duration', 'otlp-metrics')
      expect(http).toMatchObject({ unit: 's' })
      expect(http.histogram.aggregationTemporality).toBe(2)
      const points = http.histogram.dataPoints
      const allowed = new Set([
        'http.request.method',
        'url.scheme',
        'http.route',
        'http.response.status_code',
        'error.type',
      ])

      for (const point of points) {
        expect(Object.keys(attrsOf(point)).every(key => allowed.has(key))).toBe(true)
        expect(point.explicitBounds).toEqual(SEMCONV_BUCKETS)
        expect(point.bucketCounts).toHaveLength(SEMCONV_BUCKETS.length + 1)
        expect(Number(point.count)).toBeGreaterThanOrEqual(1)
        expect(point.sum).toBeLessThan(10)
      }

      const ok = points.find((point: AnyType) => attrOf(point, 'http.route') === '/todos/create')
      expect(attrsOf(ok)).toEqual({
        'http.request.method': 'POST',
        'url.scheme': 'http',
        'http.route': '/todos/create',
        'http.response.status_code': 200,
      })
      const failed = points.find(
        (point: AnyType) => attrOf(point, 'http.route') === '/todos/explode',
      )
      // a 5xx carries error.type — the same value the span has
      expect(attrsOf(failed)).toMatchObject({
        'http.response.status_code': 500,
        'error.type': 'x.y',
      })

      // ozaco.action.duration: the in-process dispatch spans, under the SERVICE's resource
      const [action] = byName('ozaco.action.duration', 'todos')
      expect(action.unit).toBe('s')
      const attributeSets = action.histogram.dataPoints.map((point: AnyType) => attrsOf(point))
      expect(attributeSets).toContainEqual({ 'code.function.name': 'todos.create' })
      expect(attributeSets).toContainEqual({
        'code.function.name': 'todos.explode',
        'error.type': 'x.y',
      })

      // ozaco.service.up: 1 per served service, in that service's resource
      const [up] = byName('ozaco.service.up', 'todos')
      expect(up.gauge.dataPoints).toEqual([
        expect.objectContaining({ asInt: '1', startTimeUnixNano: expect.any(String) }),
      ])
    },
  )
})

describe('observe/otlp — active requests', () => {
  it.each(['protobuf', 'json'] as const)(
    'http.server.active_requests (%s): the requests in flight, per method + scheme',
    async encoding => {
      const collector = fakeCollector()
      let during: AnyType[] = []

      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos],
            name: 'otlp-active',
            edge: BunEdge,
            plugins: [
              OtlpExporter.use({
                url: 'http://collector:4318',
                fetch: collector.fetch,
                encoding,
                batch: { waitMs: 10 },
                metrics: { intervalMs: 40 },
              }),
            ],
          })
          const info = yield* server.start({ port: 0 })
          const slow = fetch(`${info.url!}/todos/slow?ms=400`)
          // metrics beats while the request is still being answered
          yield* sleep(200)
          during = collector.metrics()
          expect((yield* until(slow)).status).toBe(200)
          yield* server.stop()
        }),
      )

      const activeOf = (metrics: AnyType[]) =>
        metrics.find(
          metric =>
            metric.name === 'http.server.active_requests' && metric.$service === 'otlp-active',
        )
      const valueOf = (point: AnyType) => Number(point.asInt ?? 0)

      // an up-down counter (a non-monotonic cumulative sum) of the node's resource
      const inflight = activeOf(during)
      expect(inflight.unit).toBe('{request}')
      expect(inflight.sum.isMonotonic ?? false).toBe(false)
      expect(inflight.sum.aggregationTemporality).toBe(2)
      expect(
        inflight.sum.dataPoints.map((point: AnyType) => [attrsOf(point), valueOf(point)]),
      ).toEqual([[{ 'http.request.method': 'GET', 'url.scheme': 'http' }, 1]])

      // answered: back to zero
      const after = activeOf(collector.metrics())
      expect(after.sum.dataPoints.map(valueOf)).toEqual([0])
    },
  )
})

describe('observe/otlp — lifecycle', () => {
  it('the metrics beat runs while the node does: nothing after stop, ONE beat again after a restart', async () => {
    const collector = fakeCollector()
    const posts = () => collector.of('/v1/metrics').length
    const seen: number[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          name: 'otlp-beat',
          plugins: [
            OtlpExporter.use({
              url: 'http://collector:4318',
              fetch: collector.fetch,
              batch: { waitMs: 10 },
              metrics: { intervalMs: 20 },
            }),
          ],
        })
        yield* server.start()
        yield* sleep(110)
        // the beat POSTs while the node runs, not only at stop
        expect(posts()).toBeGreaterThan(1)
        yield* server.stop()
        seen.push(posts())

        // a stopped node reports nothing more (no `ozaco.service.up` of a node that is gone)
        yield* sleep(100)
        expect(posts()).toBe(seen[0]!)

        // a restart begins ONE new beat (never a second one next to a stale one)
        yield* server.start()
        yield* sleep(110)
        seen.push(posts() - seen[0]!)
        yield* server.stop()
      }),
    )

    // ~5 beats in 110 ms at 20 ms; two beats side by side would be ~10
    expect(seen[1]).toBeGreaterThan(1)
    expect(seen[1]).toBeLessThanOrEqual(7)
  })
})

describe('observe/otlp — transport', () => {
  /** Run one node against `collector`, make one call, stop; resolve the exporter's stats. */
  const exercise = (
    collector: ReturnType<typeof fakeCollector>,
    options: Partial<Parameters<typeof OtlpExporter.use>[0]> = {},
    body?: (call: () => Operation<unknown>) => Operation<void>,
  ) =>
    run(function* () {
      yield* storage()
      const server = yield* createServer({
        services: [todos],
        plugins: [
          OtlpExporter.use({
            url: 'http://collector:4318',
            fetch: collector.fetch,
            batch: { waitMs: 10 },
            metrics: false,
            retry: { initialMs: 1, maxMs: 5 },
            ...options,
          }),
        ],
      })
      yield* server.start()
      const made = yield* server.call(todos, 'create', { title: 'shipped' })
      expect(made.title).toBe('shipped')

      if (body) {
        yield* body(() => server.call(todos, 'create', { title: 'again' }))
      }

      yield* server.stop()

      return (yield* OtlpExporter.context.expect()).stats()
    })

  it('retries 429/502/503/504 and network errors (Retry-After honoured); partialSuccess is counted', async () => {
    let traces = 0
    const collector = fakeCollector(entry => {
      if (!entry.url.endsWith('/v1/traces')) {
        return new Response('{}', { status: 200 })
      }

      traces += 1

      if (traces === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
      }

      if (traces === 2) {
        throw new TypeError('fetch failed: ECONNREFUSED')
      }

      if (traces === 3) {
        return new Response('bad gateway', { status: 502 })
      }

      return Response.json({ partialSuccess: { rejectedSpans: '2', errorMessage: 'too old' } })
    })

    const stats = unwrap(await exercise(collector))

    expect(traces).toBe(4)
    expect(stats.spans).toMatchObject({ retried: 3, rejected: 2, failed: 0, lastError: 'too old' })
    expect(stats.spans.sent).toBeGreaterThan(0)
    // every attempt carried the same payload
    const bodies = collector.of('/v1/traces').map(entry => entry.body.join(','))
    expect(new Set(bodies).size).toBe(1)
  })

  it('a destination that failed for good gets ONE attempt per delivery until it answers again', async () => {
    let up = false
    const collector = fakeCollector(entry =>
      up || !entry.url.endsWith('/v1/traces')
        ? new Response('{}', { status: 200 })
        : new Response('unavailable', { status: 503 }),
    )
    const traces = () => collector.of('/v1/traces').length

    const stats = unwrap(
      await exercise(
        collector,
        { retry: { attempts: 3, initialMs: 1, maxMs: 1 } },
        function* (call) {
          yield* sleep(40)
          // the first delivery: 3 attempts, then the failure streak starts
          expect(traces()).toBe(3)
          yield* call()
          yield* sleep(40)
          // the backend is known down: one attempt
          expect(traces()).toBe(4)
          up = true
          yield* call()
          yield* sleep(40)
          expect(traces()).toBe(5)
        },
      ),
    )

    expect(stats.spans.retried).toBe(2)
    expect(stats.spans.sent).toBeGreaterThan(0)
    expect(stats.spans.failed).toBeGreaterThan(0)
  })

  /** One node whose first call records spans only (no log record); then `body` runs. */
  const spansFirst = (collector: ReturnType<typeof fakeCollector>, body: () => Operation<void>) =>
    run(function* () {
      yield* storage()
      const server = yield* createServer({
        services: [todos],
        plugins: [
          OtlpExporter.use({
            url: 'http://collector:4318',
            fetch: collector.fetch,
            batch: { waitMs: 10 },
            metrics: false,
            retry: { attempts: 3, initialMs: 1, maxMs: 1 },
          }),
        ],
      })
      yield* server.start()
      yield* server.call(todos, 'list', {})
      yield* sleep(60)
      yield* body()
      yield* server.stop()
    })

  it('a destination that ANSWERS NOTHING costs one retry budget: every signal then gets one attempt until it answers', async () => {
    let down = true
    const collector = fakeCollector(() => {
      if (down) {
        throw new TypeError('fetch failed: ECONNREFUSED')
      }

      return new Response('{}', { status: 200 })
    })
    const count = (signal: string) => collector.of(`/v1/${signal}`).length

    unwrap(
      await spansFirst(collector, function* () {
        // the traces delivery spent its whole budget on a refused connection
        expect(count('traces')).toBe(3)
        expect(count('logs')).toBe(0)

        // the LOGS signal never failed — but the destination is known unreachable: one attempt
        yield* Server.actions.report({ stream: 'audit', verb: 'while.down' })
        yield* sleep(60)
        expect(count('logs')).toBe(1)

        // it is back: delivered
        down = false
        yield* Server.actions.report({ stream: 'audit', verb: 'back.up' })
        yield* sleep(60)
        expect(count('logs')).toBe(2)
      }),
    )
  })

  it('a destination that ANSWERS (even with an error) keeps every other signal on its full budget', async () => {
    let busy = 0
    const collector = fakeCollector(entry => {
      if (entry.url.endsWith('/v1/traces')) {
        return new Response('bad request', { status: 400 })
      }

      busy += 1

      return busy <= 2 ? new Response('busy', { status: 503 }) : new Response('{}')
    })

    unwrap(
      await spansFirst(collector, function* () {
        expect(collector.of('/v1/traces')).toHaveLength(1)

        // the traces refusal was an ANSWER: the logs delivery retries as usual
        yield* Server.actions.report({ stream: 'audit', verb: 'retried' })
        yield* sleep(60)
        expect(collector.of('/v1/logs')).toHaveLength(3)
      }),
    )
  })

  it('never retries any other status; the refusal lands in the stats with the backend answer', async () => {
    const collector = fakeCollector(entry =>
      entry.url.endsWith('/v1/traces')
        ? new Response('Invalid json: invalid type: map, expected f64', { status: 400 })
        : new Response('{}', { status: 200 }),
    )

    const stats = unwrap(await exercise(collector))

    expect(collector.of('/v1/traces')).toHaveLength(1)
    expect(stats.spans.retried).toBe(0)
    expect(stats.spans.failed).toBeGreaterThan(0)
    expect(stats.spans.lastError).toContain('400')
    expect(stats.spans.lastError).toContain('expected f64')
  })

  it('reads a protobuf partialSuccess (ExportTraceServiceResponse)', async () => {
    // { partial_success (1): { rejected_spans (1): 3, error_message (2): 'nope' } }
    const inner = [0x08, 0x03, 0x12, 0x04, ...new TextEncoder().encode('nope')]
    const answer = new Uint8Array([0x0a, inner.length, ...inner])
    const collector = fakeCollector(
      () =>
        new Response(answer, {
          status: 200,
          headers: { 'content-type': 'application/x-protobuf' },
        }),
    )

    const stats = unwrap(await exercise(collector))

    expect(stats.spans.rejected).toBe(3)
    expect(stats.spans.lastError).toBe('nope')
  })

  /** A fetch whose `signal` paths never answer: every such POST hangs until it is aborted (the
   * abort reasons — a Failure's message — and times land in `aborted`); the rest go to
   * `collector`. */
  const hangingOn = (
    collector: ReturnType<typeof fakeCollector>,
    hangs: (url: string) => boolean,
  ) => {
    const aborted: { reason: string; at: number }[] = []
    const started: number[] = []
    const hanging = ((url: string | URL, init?: RequestInit) => {
      if (!hangs(String(url))) {
        return collector.fetch(url, init)
      }

      started.push(Date.now())

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason: unknown = init.signal?.reason
          aborted.push({
            reason: isFailure(reason) ? reason.message : String(reason),
            at: Date.now(),
          })
          reject(reason)
        })
      })
    }) as typeof fetch

    return { fetch: hanging, aborted, started }
  }

  it('timeoutMs bounds the WHOLE delivery: a hung attempt uses it up (the fetch is aborted), no retry follows', async () => {
    const collector = fakeCollector()
    const hung = hangingOn(collector, url => url.endsWith('/v1/traces'))

    const stats = unwrap(
      await exercise(collector, {
        fetch: hung.fetch,
        timeoutMs: 20,
        retry: { attempts: 2, initialMs: 1, maxMs: 1 },
      }),
    )

    // one attempt, aborted when the delivery's 20 ms ran out — a second attempt would start
    // past the delivery's deadline, so none is made
    expect(hung.aborted).toHaveLength(1)
    expect(hung.aborted[0]!.reason).toContain('timed out')
    expect(hung.aborted[0]!.reason).toContain('20ms')
    expect(stats.spans.retried).toBe(0)
    expect(stats.spans.failed).toBeGreaterThan(0)
  })

  it('the attempts SHARE the delivery`s timeoutMs: a retry gets only what is left of it', async () => {
    let traces = 0
    const collector = fakeCollector()
    const answers = hangingOn(collector, url => url.endsWith('/v1/traces'))
    // the first attempt answers 503 — after 60 ms of the delivery's 150
    const busyFirst = ((url: string | URL, init?: RequestInit) =>
      String(url).endsWith('/v1/traces') && traces === 0
        ? new Promise<Response>(resolve => {
            traces += 1
            setTimeout(() => resolve(new Response('busy', { status: 503 })), 60)
          })
        : answers.fetch(url, init)) as typeof fetch
    let began = 0

    const stats = unwrap(
      await exercise(
        collector,
        {
          fetch: busyFirst,
          timeoutMs: 150,
          retry: { attempts: 3, initialMs: 1, maxMs: 1 },
          batch: { waitMs: 60_000 },
        },
        function* () {
          began = Date.now()
        },
      ),
    )

    // attempt 2 hung and was aborted at the delivery's deadline — ~90 ms after it began, not
    // after a fresh 150 ms of its own
    expect(answers.aborted).toHaveLength(1)
    expect(answers.aborted[0]!.at - answers.started[0]!).toBeLessThan(130)
    expect(answers.aborted[0]!.at - began).toBeLessThan(150 + 80)
    expect(stats.spans.retried).toBe(1)
    expect(stats.spans.failed).toBeGreaterThan(0)
  })

  it('a black-holed collector: the stop-time flush ends in about timeoutMs, whatever is pending', async () => {
    const collector = fakeCollector()
    const hole = hangingOn(collector, () => true)
    let stoppedIn = 0

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [
            OtlpExporter.use({
              url: 'http://collector:4318',
              fetch: hole.fetch,
              // nothing leaves before the stop; then one span / record per batch
              batch: { size: 1, waitMs: 60_000 },
              timeoutMs: 150,
              retry: { attempts: 5, initialMs: 1, maxMs: 1 },
            }),
          ],
        })
        yield* server.start()
        for (let call = 0; call < 4; call += 1) {
          yield* server.call(todos, 'create', { title: `lost ${call}` })
        }

        const began = Date.now()
        yield* server.stop()
        stoppedIn = Date.now() - began
      }),
    )

    // per attempt 150 ms × 5 attempts × every pending batch would be seconds: the whole stop
    // gets ONE timeoutMs (the signals side by side, a batch still waiting at its deadline is
    // not even sent)
    expect(stoppedIn).toBeGreaterThanOrEqual(140)
    expect(stoppedIn).toBeLessThan(150 + 150)
    expect(hole.started.length).toBeGreaterThan(0)
    for (const [at, entry] of hole.aborted.entries()) {
      expect(entry.at - hole.started[at]!).toBeLessThanOrEqual(150 + 30)
    }
  })

  it('gzip: the body is compressed and marked content-encoding: gzip', async () => {
    const collector = fakeCollector()

    unwrap(await exercise(collector, { gzip: true }))

    const [first] = collector.of('/v1/traces')
    expect(first!.headers['content-encoding']).toBe('gzip')
    // the gzip magic, and it decodes to the spans
    expect([first!.body[0], first!.body[1]]).toEqual([0x1f, 0x8b])
    expect(collector.spans().some(span => span.name === 'todos.create')).toBe(true)
  })

  it('no empty envelopes: nothing observed, nothing sent', async () => {
    const collector = fakeCollector()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [
            OtlpExporter.use({
              url: 'http://collector:4318',
              fetch: collector.fetch,
              metrics: false,
            }),
          ],
        })
        yield* server.start()
        yield* server.stop()
      }),
    )

    expect(collector.received).toHaveLength(0)
  })

  it('a failing collector: ONE warn per streak through the Logger (suppressed), never telemetry, never the caller', async () => {
    const logged = captureLogger()
    const memory = memoryExporter()
    const collector = fakeCollector(() => new Response('gone', { status: 404 }))

    unwrap(
      await run(function* () {
        yield* DefaultLogger.use({ level: LogLevel.info })
        yield* logged.transport.use()
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [
            memory.plugin,
            OtlpExporter.use({
              url: 'http://collector:4318',
              fetch: collector.fetch,
              batch: { waitMs: 5 },
              metrics: false,
            }),
          ],
        })
        yield* server.start()
        const first = yield* server.call(todos, 'create', { title: 'one' })
        yield* sleep(40)
        const second = yield* server.call(todos, 'create', { title: 'two' })
        yield* sleep(40)
        expect([first.title, second.title]).toEqual(['one', 'two'])
        yield* server.stop()
      }),
    )

    const warns = logged.entries.filter(entry => entry.msg === 'otlp traces delivery failing')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.level).toBe(LogLevel.warn)
    expect(warns[0]!.bindings?.['logger']).toBe('@ozaco/server/observe')
    expect(warns[0]!.error).toContain('404')
    // the complaint itself never became a record any sink sees
    expect(
      memory.seen.some(event => event.t === 'log' && event.log.body.includes('delivery failing')),
    ).toBe(false)
  })
})

describe('createSink', () => {
  it('a FULL batch leaves at once — no waiting for the beat', async () => {
    const sent: number[][] = []

    unwrap(
      await run(function* () {
        const sink = createSink<number>({
          size: 2,
          waitMs: 60_000,
          *send(rows) {
            sent.push([...rows])
          },
        })
        yield* sink.start()
        sink.push(1)
        yield* sleep(10)
        expect(sent).toEqual([])
        for (const row of [2, 3]) {
          sink.push(row)
        }
        yield* sleep(10)
        expect(sent).toEqual([[1, 2]])
        expect(sink.stats.sent).toBe(2)
      }),
    )
  })

  it('flush() waits for the send in flight, then sends what arrived meanwhile', async () => {
    const sent: number[][] = []

    unwrap(
      await run(function* () {
        const sink = createSink<number>({
          size: 10,
          waitMs: 60_000,
          *send(rows) {
            yield* sleep(30)
            sent.push([...rows])
          },
        })
        sink.push(1)
        yield* spawn(() => sink.flush())
        yield* sleep(5)
        sink.push(2)
        // the first flush is mid-send: this one must not return before both rows left
        yield* sink.flush()
        expect(sent).toEqual([[1], [2]])
        expect(sink.stats.sent).toBe(2)
      }),
    )
  })

  it('a failed batch is counted, onError hears the first failure of a streak only', async () => {
    const heard: unknown[] = []

    unwrap(
      await run(function* () {
        const sink = createSink<number>({
          size: 1,
          *send() {
            return yield* fail('test.down', 'down')
          },
          onError: failure => heard.push(failure),
        })
        for (const row of [1, 2]) {
          sink.push(row)
        }
        yield* sink.flush()
        expect(sink.stats).toEqual({ sent: 0, dropped: 0, failed: 2 })
        expect(heard).toHaveLength(1)
      }),
    )
  })
})
