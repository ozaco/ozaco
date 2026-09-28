/**
 * The observe store: every span and log record the kernel reports is one row of `_ob2_spans` /
 * `_ob2_logs` (with its resource) — exactly what every exporter receives. `traces()` lists the
 * roots, `trace()` / `request()` assemble one trace, exceptions are log records.
 */
import { column, DbAdapter, DbClient, table } from 'db:core'
import type { ObserveDef } from 'server:core'
import {
  action,
  createServer,
  Edge,
  Observe,
  ObserveExporter,
  ServerErrors,
  service,
} from 'server:core'
import {
  Auth,
  eventOfLogRow,
  eventOfSpanRow,
  isExceptionLog,
  ObservePlugin,
  StaticAuth,
} from 'server:plugins'
import { attempt, fork, run, scoped, sleep, until } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

import { storage, todos } from '../helpers'

/** A socket: every inbound frame the handler pulls is a root span of its own. */
const chat = service('chat', {
  room: action.socket(
    { protocol: 'chat', receives: z.object({ text: z.string() }) },
    function* (socket) {
      const messages = yield* socket.messages

      for (;;) {
        const step = yield* messages.next()

        if (step.done) {
          return
        }

        yield* socket.send({ t: 'echo', text: step.value.text })
      }
    },
  ),
})

let installs = 0

/** An in-memory exporter next to the store: every event the kernel reports to the sinks. */
const memoryExporter = () => {
  installs += 1

  const events: ObserveDef.Event[] = []

  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: `test/observe-memory-${installs}`,
    version: '1.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      events.push(event)
    },
    *start() {},
    *flush() {},
  })

  return { plugin, events }
}

const spanNames = (view: ObserveDef.TraceView | null): string[] =>
  (view?.spans ?? []).map(span => span.name)

/** The trace list's order: newest start first; the same start ⇒ the higher span id first. */
const newestFirst = (left: ObserveDef.SpanRow, right: ObserveDef.SpanRow): number =>
  right.start - left.start ||
  (right.span_id > left.span_id ? 1 : right.span_id < left.span_id ? -1 : 0)

/** A synthetic span of the `hop` services: `parent: null` a root, `local: true` a child of a
 * span of its own node, else a LOCAL root under a remote parent (a carrier hop). */
const spanAt = (input: {
  readonly traceId: string
  readonly spanId: string
  readonly parent: string | null
  readonly start: number
  readonly local?: boolean
  readonly service?: string
}): ObserveDef.Event => {
  const named = input.service ?? 'hop'

  return {
    t: 'span',
    resource: { 'service.name': named, 'service.instance.id': `${named}-1` },
    span: {
      context: { traceId: input.traceId, spanId: input.spanId, flags: 1 },
      parent:
        input.parent === null
          ? null
          : {
              traceId: input.traceId,
              spanId: input.parent,
              flags: 1,
              ...(input.local === true ? {} : { remote: true }),
            },
      name: input.local === true ? 'hop.call' : 'hop',
      kind: input.local === true ? 'client' : 'server',
      service: named,
      scope: { name: 'test' },
      start: input.start,
      end: input.start + 1,
      attributes: {},
      droppedAttributes: 0,
      events: [],
      droppedEvents: 0,
      links: [],
      droppedLinks: 0,
      status: { code: 'unset' },
    },
  }
}

/** A synthetic local root (what the kernel reports for a span with no parent). */
const rootAt = (spanId: string, start: number): ObserveDef.Event => ({
  t: 'span',
  resource: { 'service.name': 'tie', 'service.instance.id': 'tie-1' },
  span: {
    context: { traceId: spanId.padStart(32, '0'), spanId, flags: 1 },
    parent: null,
    name: 'tie.root',
    kind: 'internal',
    service: 'tie',
    scope: { name: 'test' },
    start,
    end: start + 1,
    attributes: {},
    droppedAttributes: 0,
    events: [],
    droppedEvents: 0,
    links: [],
    droppedLinks: 0,
    status: { code: 'unset' },
  },
})

describe('observe — spans and log records are db rows', () => {
  it('an HTTP request is a ROOT span: captured headers (redacted) and bodies; a GET query is url.query', async () => {
    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          // the plugin's `capture` is the server's one capture switch
          plugins: [
            ObservePlugin.use({ batch: { waitMs: 10 }, capture: { headers: true, bodies: true } }),
          ],
        })

        yield* server.start()

        const created = yield* Edge.actions.handle(
          new Request('http://edge/todos/create', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer sekrit',
              'x-tool': 'observe-test',
            },
            body: JSON.stringify({ title: 'captured' }),
          }),
        )

        expect(created.status).toBe(200)

        const requestId = created.headers.get('x-request-id')!

        const streamed = yield* Edge.actions.handle(new Request('http://edge/todos/count?n=2'))

        yield* until(streamed.text())
        yield* sleep(30) // the edge span ends WITH the streamed body

        const create = (yield* Observe.actions.traces({ route: '/todos/create' })).traces

        expect(create).toHaveLength(1)

        const root = create[0]!

        expect(root).toMatchObject({
          name: 'POST /todos/create',
          kind: 'server',
          root: true,
          parent_span_id: null,
          http_route: '/todos/create',
          http_status: 200,
          status_code: 'unset',
          error_type: null,
          scope: '@ozaco/server',
        })
        expect(root.service_instance_id).toBeString()
        // headers land redacted, never the bearer
        expect(root.attributes['http.request.header.authorization']).toEqual(['REDACTED'])
        expect(root.attributes['http.request.header.x-tool']).toEqual(['observe-test'])
        // the value planes keep (capped) JSON text
        expect(JSON.parse(String(root.attributes['http.request.body.content']))).toEqual({
          title: 'captured',
        })
        expect(String(root.attributes['http.response.body.content'])).toContain('captured')

        // the request id minted here IS the trace id: request() and trace() are the same view
        expect(requestId).toBe(root.trace_id)

        const view = yield* Observe.actions.request(requestId)

        expect(view).toEqual(yield* Observe.actions.trace(root.trace_id))

        const dispatch = view!.spans.find(span => span.name === 'todos.create')!

        expect(dispatch).toMatchObject({ kind: 'internal', parent_span_id: root.span_id })
        expect(dispatch.service_name).toBe('todos')

        // the handler's log line hangs off the dispatch span
        const creating = view!.logs.find(log => log.body === 'creating')!

        expect(creating).toMatchObject({ span_id: dispatch.span_id, severity_number: 9 })
        expect(creating.attributes['title']).toBe('captured')

        // a GET's value input is the query string — never a request body
        const count = (yield* Observe.actions.traces({ name: 'GET /todos/count' })).traces[0]!

        expect(count.attributes['url.query']).toBe('n=2')
        expect(count.attributes['http.request.body.content']).toBeUndefined()
        // a flow reply is its shape + the streamed SIZE, never its items
        expect(count.attributes['ozaco.response.body.kind']).toBe('flow')
        expect(count.attributes['http.response.body.size'] as number).toBeGreaterThan(0)

        // a CONTINUED request (an exporting ozaco caller, `ozaco=1`) gets a fresh request id —
        // never the shared trace id — and the store still finds its trace by it
        const caller = '4bf92f3577b34da6a3ce929d0e0e4736'
        const continued = yield* Edge.actions.handle(
          new Request('http://edge/todos/list', {
            headers: { traceparent: `00-${caller}-00f067aa0ba902b7-01`, tracestate: 'ozaco=1' },
          }),
        )

        yield* until(continued.text())

        const freshId = continued.headers.get('x-request-id')!

        expect(freshId).not.toBe(caller)
        yield* sleep(30)

        const found = yield* Observe.actions.request(freshId)

        expect(found?.trace_id).toBe(caller)
        expect(spanNames(found)).toContain('GET /todos/list')

        yield* server.stop()
      }),
    )
  })

  it('traces() lists the roots newest first and filters; trace() holds spans + logs; a failure is ONE exception record', async () => {
    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [todos],
          plugins: [ObservePlugin.use({ batch: { waitMs: 10 } })],
        })

        yield* server.call(todos, 'create', { title: 'observed' })
        yield* attempt(server.call(todos, 'explode', { code: 'todo.kaput' }))
        yield* server.call(todos, 'nested', { title: 'deep' })

        const page = yield* Observe.actions.traces({})

        // one root per call, newest first — three calls may well start in the same millisecond
        // (a root's start is the wall clock's): those are listed by span id, never by the order
        // their rows were written in
        expect(page.traces.map(row => row.name).toSorted()).toEqual([
          'todos.create',
          'todos.explode',
          'todos.nested',
        ])
        expect(page.traces).toEqual(page.traces.toSorted(newestFirst))
        expect(page.cursor).toBeNull()

        const failed = (yield* Observe.actions.traces({ status: 'failed' })).traces

        expect(failed).toHaveLength(1)
        expect(failed[0]).toMatchObject({
          name: 'todos.explode',
          error_type: 'todo.kaput',
          status_code: 'error',
          status_message: 'boom todo.kaput',
        })
        expect((yield* Observe.actions.traces({ status: 'error' })).traces).toHaveLength(1)
        expect((yield* Observe.actions.traces({ errorType: 'todo.kaput' })).traces).toHaveLength(1)
        expect(
          (yield* Observe.actions.traces({ service: 'todos', status: 'ok' })).traces,
        ).toHaveLength(2)
        expect((yield* Observe.actions.traces({ name: 'todos.create' })).traces).toHaveLength(1)
        expect((yield* Observe.actions.traces({ since: Date.now() + 60_000 })).traces).toHaveLength(
          0,
        )
        expect((yield* Observe.actions.traces({ slowerThan: 60_000 })).traces).toHaveLength(0)

        // cursor paging walks the same list
        const first = yield* Observe.actions.traces({ limit: 2 })

        expect(first.traces).toHaveLength(2)

        const second = yield* Observe.actions.traces({ limit: 2, cursor: first.cursor! })

        expect([...first.traces, ...second.traces]).toEqual([...page.traces])

        // the create trace: the dispatch root, the db work under it, its log line
        const created = page.traces.find(row => row.name === 'todos.create')!
        const view = yield* Observe.actions.trace(created.trace_id)

        expect(view!.spans[0]).toMatchObject({ span_id: created.span_id, root: true })

        for (const span of view!.spans.slice(1)) {
          expect(span.root).toBe(false)
        }

        expect(view!.logs.map(log => log.body)).toEqual(['creating'])
        expect(view!.logs[0]!.span_id).toBe(created.span_id)

        // the failed trace: ONE exception span event at the origin + ONE exception log record
        const exploded = yield* Observe.actions.trace(failed[0]!.trace_id)
        const exceptions = exploded!.logs.filter(log => isExceptionLog(log))

        expect(exceptions).toHaveLength(1)
        expect(exceptions[0]).toMatchObject({
          event_name: 'ozaco.action.exception',
          severity_number: 17,
          span_id: failed[0]!.span_id,
        })
        expect(exceptions[0]!.attributes['exception.type']).toBe('todo.kaput')
        expect(exceptions[0]!.body).toContain('boom todo.kaput')
        expect(exploded!.spans[0]!.events.map(event => event.name)).toEqual(['exception'])

        // the nested trace: parent/child dispatches + the producer span of the emit
        const nested = page.traces.find(row => row.name === 'todos.nested')!
        const view3 = yield* Observe.actions.trace(nested.trace_id)

        expect(spanNames(view3)).toContain('todos.create')
        expect(spanNames(view3)).toContain('publish todo.created')

        const inner = view3!.spans.find(span => span.name === 'todos.create')!
        const publish = view3!.spans.find(span => span.name === 'publish todo.created')!

        expect(inner.parent_span_id).toBe(nested.span_id)
        expect(publish).toMatchObject({ kind: 'producer', parent_span_id: nested.span_id })

        // parents come before their children
        const order = view3!.spans.map(span => span.span_id)

        expect(order.indexOf(nested.span_id)).toBeLessThan(order.indexOf(inner.span_id))

        const stats = yield* Observe.actions.stats()

        expect(stats.recorded).toBeGreaterThanOrEqual(7)
        expect(stats).toMatchObject({ dropped: 0, pending: 0, forwarded: 0, received: 0 })
        expect(yield* Observe.actions.request('nope')).toBeNull()
        expect(yield* Observe.actions.trace('nope')).toBeNull()
      }),
    )
  })

  it('the store holds EXACTLY what the exporters receive — and nothing of its own work', async () => {
    const sink = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [ObservePlugin.use({ batch: { waitMs: 10 } }), sink.plugin],
        })

        yield* server.start()
        yield* server.call(todos, 'nested', { title: 'parity' })
        yield* attempt(server.call(todos, 'explode', { code: 'todo.kaput' }))

        const response = yield* Edge.actions.handle(new Request('http://edge/todos/list'))

        yield* until(response.text())
        // the store answers several reads — none of them is telemetry
        yield* Observe.actions.traces({})
        yield* Observe.actions.stats()
        yield* sleep(30)

        const traces = (yield* Observe.actions.traces({})).traces
        const stored: ObserveDef.Event[] = []

        for (const root of traces) {
          const view = (yield* Observe.actions.trace(root.trace_id))!

          stored.push(...view.spans.map(eventOfSpanRow), ...view.logs.map(eventOfLogRow))
        }

        yield* server.stop()

        // the exporter saw no span of the store's own db work, no cluster plumbing
        const exported = sink.events

        for (const event of exported) {
          if (event.t === 'span') {
            expect(String(event.span.attributes['db.collection.name'] ?? '')).not.toMatch(/^_ob/u)
            expect(event.span.name).not.toContain('_observe')
          }
        }

        // …and the store decodes back to the very events the exporter got, for every trace it
        // holds (a decoded record names its RESOLVED service: the resource's `service.name`)
        const traced = new Set(traces.map(root => root.trace_id))
        const traceOf = (event: ObserveDef.Event): string =>
          event.t === 'span' ? event.span.context.traceId : (event.log.context?.traceId ?? '')
        const key = (event: ObserveDef.Event): string =>
          event.t === 'span'
            ? `span:${event.span.context.spanId}`
            : `log:${event.log.context?.spanId}:${event.log.time}:${event.log.body}`
        const wanted = new Map(
          exported
            .filter(event => traced.has(traceOf(event)))
            .map(event => [key(event), event] as const),
        )
        const got = new Map(stored.map(event => [key(event), event] as const))

        expect(wanted.size).toBeGreaterThan(8)
        expect([...got.keys()].toSorted()).toEqual([...wanted.keys()].toSorted())

        for (const [at, event] of wanted) {
          const mine = got.get(at) as AnyType

          expect(mine.resource).toEqual(event.resource)

          if (event.t === 'span') {
            const { parent, ...rest } = event.span
            const { parent: parentOf, ...restOf } = mine.span

            expect(restOf).toEqual({ ...rest, service: event.resource['service.name'] })
            expect(parentOf?.spanId ?? null).toBe(parent?.spanId ?? null)
          } else {
            expect(mine.log).toEqual({ ...event.log, service: event.resource['service.name'] })
          }
        }
      }),
    )
  })

  it('the console manifest is ozaco/2 — what @ozaco/client requires to bootstrap', async () => {
    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [ObservePlugin.use({ console: true, batch: { waitMs: 10 } })],
        })
        const info = yield* server.start({ port: 0 })

        const manifest = (yield* until(
          fetch(`${info.url}/_observe/api/manifest`).then(response => response.json()),
        )) as AnyType

        expect(manifest.manifest).toBe('ozaco/2')

        const observe = manifest.services.find((entry: AnyType) => entry.name === 'observe')
        const actions = observe.actions.map((entry: AnyType) => entry.action)

        for (const name of ['traces', 'trace', 'request', 'stats', 'cluster', 'live']) {
          expect(actions).toContain(name)
        }

        const page = yield* until(fetch(`${info.url}/_observe`))

        expect(page.headers.get('content-type')).toContain('text/html')
        yield* until(page.text())

        yield* server.stop()
      }),
    )
  })

  it('auth gates the observe API like any action; the console page is a public shell', async () => {
    const API = [
      '/_observe/api/traces',
      '/_observe/api/trace/nope',
      '/_observe/api/request/nope',
      '/_observe/api/stats',
      '/_observe/api/cluster',
      '/_observe/api/live',
      '/_observe/api/manifest',
    ]

    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [
            ObservePlugin.use({
              console: true,
              auth: principal => principal.roles.includes('observe'),
              batch: { waitMs: 10 },
            }),
            StaticAuth.use({
              tokens: {
                'tok-ops': { sub: 'ops', roles: ['observe'] },
                'tok-user': { sub: 'user', roles: [] },
              },
            }),
            Auth,
          ],
        })

        yield* server.start()

        const status = function* (path: string, token?: string) {
          const response = yield* Edge.actions.handle(
            new Request(`http://edge${path}`, {
              headers: token ? { authorization: `Bearer ${token}` } : {},
            }),
          )

          yield* until(response.body?.cancel() ?? Promise.resolve())

          return response.status
        }

        for (const path of API) {
          // nobody, or a principal the requirement refuses: nothing leaves the store
          expect([path, yield* status(path)]).toEqual([path, 401])
          expect([path, yield* status(path, 'tok-user')]).toEqual([path, 403])
        }

        expect(yield* status('/_observe/api/stats', 'tok-ops')).toBe(200)
        expect(yield* status('/_observe/api/traces', 'tok-ops')).toBe(200)
        expect(yield* status('/_observe/api/trace/nope', 'tok-ops')).toBe(404)

        // the page holds no data: a browser loads it, the API asks it for a token
        expect(yield* status('/_observe')).toBe(200)

        // the API is the service's, in-process calls go through the same gate
        const stats = { service: 'observe', action: 'stats' } as AnyType
        const refused = yield* attempt(server.call(stats, undefined as AnyType))

        expect((refused as AnyType).error).toBe(ServerErrors.Unauthorized)

        yield* server.stop()
      }),
    )
  })

  for (const [auth, expected] of [
    [undefined, 401],
    [false, 200],
  ] as const) {
    it(`under a fail-closed Auth default the API answers ${expected} with auth: ${auth}`, async () => {
      unwrap(
        await run(function* () {
          yield* storage()

          const server = yield* createServer({
            services: [todos],
            edge: BunEdge,
            plugins: [
              // no auth of its own: Auth's default applies; `false` opens the API anyway
              ObservePlugin.use({ auth, batch: { waitMs: 10 } }),
              StaticAuth.use({ tokens: { tok: { sub: 'ops', roles: [] } } }),
              Auth.use({ default: 'authenticated' }),
            ],
          })

          yield* server.start()

          const response = yield* Edge.actions.handle(new Request('http://edge/_observe/api/stats'))

          yield* until(response.text())
          expect(response.status).toBe(expected)
          yield* server.stop()
        }),
      )
    })
  }

  it('auth without the Auth plugin fails createServer — never a silently open API', async () => {
    let failed: AnyType

    unwrap(
      await run(function* () {
        yield* storage()
        failed = yield* attempt(
          createServer({
            services: [todos],
            plugins: [ObservePlugin.use({ auth: 'authenticated' })],
          }),
        )
      }),
    )

    expect(isFailure(failed)).toBe(true)
    expect(failed.error).toBe(ServerErrors.Configuration)
    expect(failed.message).toContain('"auth"')
  })

  for (const selfTrace of [false, true]) {
    it(`the console records its own traffic only when it fails — unless selfTrace (${selfTrace})`, async () => {
      unwrap(
        await run(function* () {
          yield* storage()

          const server = yield* createServer({
            services: [todos],
            edge: BunEdge,
            plugins: [ObservePlugin.use({ console: true, selfTrace, batch: { waitMs: 10 } })],
          })

          yield* server.start()

          for (const path of ['/_observe', '/_observe/api/stats', '/_observe/api/trace/nope']) {
            const response = yield* Edge.actions.handle(new Request(`http://edge${path}`))

            yield* until(response.text())
          }

          yield* sleep(30)

          const names = (yield* Observe.actions.traces({})).traces.map(row => row.name).toSorted()

          // a failing console call is always kept (with its exception record); a fine one only
          // when the plugin traces itself
          expect(names).toEqual(
            selfTrace
              ? ['GET /_observe', 'GET /_observe/api/stats', 'GET /_observe/api/trace/:id']
              : ['GET /_observe/api/trace/:id'],
          )

          const missing = (yield* Observe.actions.traces({ name: 'GET /_observe/api/trace/:id' }))
            .traces[0]!

          expect(missing).toMatchObject({ http_status: 404, error_type: 'observe.not-found' })

          const view = yield* Observe.actions.trace(missing.trace_id)

          expect(view!.logs.filter(log => isExceptionLog(log))).toHaveLength(1)

          yield* server.stop()
        }),
      )
    })
  }

  it('a websocket frame is a ROOT span of its own, linked to the upgrade span', async () => {
    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [chat],
          edge: BunEdge,
          plugins: [ObservePlugin.use({ batch: { waitMs: 10 }, capture: { frames: true } })],
        })
        const info = yield* server.start({ port: 0 })

        yield* until(
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/chat/room`)

            ws.addEventListener('open', () => ws.send(JSON.stringify({ text: 'hi there' })))
            ws.addEventListener('message', () => {
              ws.close()
              resolve()
            })
            ws.addEventListener('error', () => reject(new Error('socket error')))
          }),
        )
        yield* sleep(60)

        const upgrade = (yield* Observe.actions.traces({ name: 'GET /chat/room' })).traces[0]

        expect(upgrade).toMatchObject({ kind: 'server', http_status: 101, root: true })

        const frames = (yield* Observe.actions.traces({ name: 'WS /chat/room' })).traces

        expect(frames).toHaveLength(1)

        const frame = frames[0]!

        // a trace of its own, LINKED to the session's upgrade span
        expect(frame.trace_id).not.toBe(upgrade!.trace_id)
        expect(frame.links).toHaveLength(1)
        expect(frame.links[0]!.context.spanId).toBe(upgrade!.span_id)
        expect(frame.links[0]!.attributes).toMatchObject({ 'ozaco.link.reason': 'ws.session' })
        expect(JSON.parse(String(frame.attributes['ozaco.ws.message.body']))).toEqual({
          text: 'hi there',
        })
        // the echo is an event on the frame span, not a span
        expect(frame.events.map(event => event.name)).toEqual(['ws.send'])

        yield* server.stop()
      }),
    )
  })

  it('the store has NO content switches: it keeps every span AND log record (an old `store` option changes nothing)', async () => {
    const sink = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [todos],
          plugins: [
            // the removed per-kind switch, as an older config still passes it
            ObservePlugin.use({ batch: { waitMs: 10 }, store: { logs: false } } as AnyType),
            sink.plugin,
          ],
        })

        // nested → create: spans + one log line ('creating')
        yield* server.call(todos, 'nested', { title: 'kept' })

        const page = yield* Observe.actions.traces({})

        expect(page.traces).toHaveLength(1)

        const view = yield* Observe.actions.trace(page.traces[0]!.trace_id)

        expect(spanNames(view)).toContain('todos.nested')
        expect(spanNames(view)).toContain('todos.create')

        // the log line the exporter got is a row too
        const exported = sink.events.filter(event => event.t === 'log')

        expect(exported.map(event => (event as AnyType).log.body)).toContain('creating')
        expect(view!.logs.map(log => log.body)).toEqual(
          exported.map(event => (event as AnyType).log.body),
        )
      }),
    )
  })

  it('traces() is deterministic when roots start in the same millisecond: span id breaks the tie', async () => {
    // written in an order that is neither ascending nor descending by span id
    const ids = ['5', 'b', '1', 'e', '8', '3', 'c', '9'].map(digit => digit.repeat(16))
    const tie = 1_700_000_000_000

    unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({
          services: [todos],
          plugins: [ObservePlugin.use({ batch: { waitMs: 10 } })],
        })

        yield* Observe.actions.record(rootAt(`${'0'.repeat(15)}a`, tie + 1))

        for (const id of ids) {
          yield* Observe.actions.record(rootAt(id, tie))
        }

        const page = yield* Observe.actions.traces({ name: 'tie.root' })
        const expected = [
          `${'0'.repeat(15)}a`,
          ...ids.toSorted((left, right) => (left < right ? 1 : -1)),
        ]

        expect(page.traces.map(row => row.span_id)).toEqual(expected)

        // cursor paging walks the very same order
        const walked: string[] = []
        let cursor: string | undefined

        do {
          const step = yield* Observe.actions.traces({ name: 'tie.root', limit: 3, cursor })

          walked.push(...step.traces.map(row => row.span_id))
          cursor = step.cursor ?? undefined
        } while (cursor !== undefined)

        expect(walked).toEqual(expected)
      }),
    )
  })

  it('traces() lists a trace by its REAL root — no parent, else the root whose parent is not stored — whatever the clocks say', async () => {
    const trace = (digit: string) => digit.repeat(32)
    const id = (name: string) => Buffer.from(name).toString('hex').padEnd(16, '0').slice(0, 16)

    unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({
          services: [todos],
          plugins: [ObservePlugin.use({ batch: { waitMs: 10 } })],
        })

        // the gateway's root (no parent) + its client span; the service node's carrier root
        // under that client span STARTS FIRST (two clocks) and is stored first (it ends first)
        yield* Observe.actions.record(
          spanAt({ traceId: trace('a'), spanId: id('api'), parent: id('gwcall'), start: 99.9 }),
        )
        yield* Observe.actions.record(
          spanAt({
            traceId: trace('a'),
            spanId: id('gwcall'),
            parent: id('gw'),
            local: true,
            start: 100.1,
          }),
        )
        yield* Observe.actions.record(
          spanAt({ traceId: trace('a'), spanId: id('gw'), parent: null, start: 100 }),
        )
        // a trace entered from an unstored caller: api-2's root (its parent not stored) is the
        // trace's row, not api-1's root under api-2's stored client span — though that starts first
        yield* Observe.actions.record(
          spanAt({
            traceId: trace('b'),
            spanId: id('api1'),
            parent: id('api2call'),
            start: 199.9,
            service: 'hop-api1',
          }),
        )
        yield* Observe.actions.record(
          spanAt({
            traceId: trace('b'),
            spanId: id('api2call'),
            parent: id('api2'),
            local: true,
            start: 200.1,
          }),
        )
        yield* Observe.actions.record(
          spanAt({ traceId: trace('b'), spanId: id('api2'), parent: id('outside'), start: 200 }),
        )

        const page = yield* Observe.actions.traces({ name: 'hop' })

        expect(page.traces.map(row => row.span_id)).toEqual([id('api2'), id('gw')])
        expect(page.cursor).toBeNull()

        // a filter that only the inner root passes lists the trace by that root
        const inner = yield* Observe.actions.traces({ service: 'hop-api1' })

        expect(inner.traces.map(row => row.span_id)).toEqual([id('api1')])
      }),
    )
  })

  it('traces() dedupes BEFORE paging: a trace is never split across pages, every page is full', async () => {
    // 12 traces, each a real root at t and a remote child's root at t + 0.5 — the rows of
    // neighbouring traces interleave (newest first: B.child, A.child, B.root, A.root, …)
    const traces = Array.from({ length: 12 }, (_, at) => ({
      traceId: String(at + 1).padStart(32, '0'),
      root: `${String(at + 1).padStart(15, '0')}r`,
      child: `${String(at + 1).padStart(15, '0')}c`,
      start: 1000 + at * 0.3,
    }))

    unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({
          services: [todos],
          plugins: [ObservePlugin.use({ batch: { waitMs: 10 } })],
        })

        for (const entry of traces) {
          yield* Observe.actions.record(
            spanAt({
              traceId: entry.traceId,
              spanId: entry.child,
              parent: 'f'.repeat(16),
              start: entry.start + 0.5,
            }),
          )
          yield* Observe.actions.record(
            spanAt({
              traceId: entry.traceId,
              spanId: entry.root,
              parent: null,
              start: entry.start,
            }),
          )
        }

        const pages: string[][] = []
        let cursor: string | undefined

        do {
          const step = yield* Observe.actions.traces({ name: 'hop', limit: 5, cursor })

          pages.push(step.traces.map(row => row.span_id))
          cursor = step.cursor ?? undefined
        } while (cursor !== undefined)

        const expected = traces.map(entry => entry.root).toReversed()

        expect(pages).toEqual([expected.slice(0, 5), expected.slice(5, 10), expected.slice(10)])

        // a cursor the store did not hand out is a validation failure, not a silent first page
        const bad = yield* attempt(() => Observe.actions.traces({ cursor: 'nope' }))

        expect(isFailure(bad) && bad.error).toBe(ServerErrors.Validation)
      }),
    )
  })

  it('watch() streams new roots as they are stored; prune() forgets the old rows', async () => {
    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({
          services: [todos],
          plugins: [ObservePlugin.use({ batch: { waitMs: 10 } })],
        })
        const live = yield* Observe.actions.watch({ status: 'failed' })
        const seen = yield* fork(function* () {
          const step = yield* live.next()

          return step.value.map(row => row.name)
        })

        yield* sleep(30)
        yield* server.call(todos, 'create', { title: 'fine' })
        yield* attempt(server.call(todos, 'explode', { code: 'x' }))
        expect(yield* seen).toEqual(['todos.explode'])

        expect((yield* Observe.actions.traces()).traces).toHaveLength(2)
        yield* sleep(5)

        const removed = yield* Observe.actions.prune(Date.now() + 1)

        // the spans, the log line and the exception record
        expect(removed).toBeGreaterThanOrEqual(4)
        expect((yield* Observe.actions.traces()).traces).toHaveLength(0)
      }),
    )
  })

  it("an older deployment's `_ob_*` tables are left untouched — the store lives in `_ob2_*`", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-observe-legacy-'))
    const path = join(dir, 'observe.sqlite')
    // the pre-std:trace span table, NOT NULL columns and all
    const legacy = table(
      '_ob_spans',
      {
        request_id: column.text(),
        service_id: column.text(),
        instance: column.text(),
        status: column.enumOf('ok', 'failed', 'cancelled'),
      },
      { log: false },
    )

    try {
      unwrap(
        await run(function* () {
          yield* BunIO.use()
          yield* SqliteAdapter.use({ path })

          const db = yield* DbClient.use({ tables: [legacy] })

          yield* db.insert('_ob_spans', {
            request_id: 'r1',
            service_id: 'old',
            instance: 'old-1',
            status: 'ok',
          })
        }),
      )

      unwrap(
        await run(function* () {
          yield* storage()

          const server = yield* createServer({
            services: [todos],
            plugins: [
              ObservePlugin.use({ db: SqliteAdapter.use({ path }), batch: { waitMs: 10 } }),
            ],
          })

          yield* server.call(todos, 'create', { title: 'next to the old rows' })
          expect((yield* Observe.actions.traces({})).traces).toHaveLength(1)
          yield* server.stop()
        }),
      )

      unwrap(
        await run(function* () {
          yield* scoped(function* () {
            yield* BunIO.use()
            yield* SqliteAdapter.use({ path })

            const tables = yield* DbAdapter.actions.tables()

            expect(tables).toEqual(expect.arrayContaining(['_ob_spans', '_ob2_spans', '_ob2_logs']))

            const db = yield* DbClient.use({ tables: [legacy], safe: true })

            expect(yield* db.query('_ob_spans').count()).toBe(1)
          })
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a separate database keeps observability out of the app adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-observe-'))

    try {
      unwrap(
        await run(function* () {
          yield* storage()

          const server = yield* createServer({
            services: [todos],
            plugins: [
              ObservePlugin.use({
                db: SqliteAdapter.use({ path: join(dir, 'observe.sqlite') }),
                batch: { waitMs: 10 },
              }),
            ],
          })

          yield* server.call(todos, 'create', { title: 'elsewhere' })
          yield* attempt(server.call(todos, 'explode', { code: 'todo.kaput' }))

          // sqlite round trip: booleans, floats, json, nulls read back as the API shape
          const page = yield* Observe.actions.traces({})

          expect(page.traces).toHaveLength(2)

          const failed = (yield* Observe.actions.traces({ status: 'failed' })).traces[0]!

          expect(failed).toMatchObject({ root: true, error_type: 'todo.kaput', http_route: null })

          const view = yield* Observe.actions.trace(failed.trace_id)

          expect(view!.spans[0]!.events[0]!.name).toBe('exception')
          expect(view!.logs.filter(log => isExceptionLog(log))).toHaveLength(1)
          expect(typeof view!.spans[0]!.start).toBe('number')

          // the app db never saw an observe table
          const tables = yield* DbAdapter.actions.tables()

          expect(tables.some((name: string) => name.startsWith('_ob'))).toBe(false)
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('non-finite numbers are the strings std spells them as — in the store exactly as the exporters got them', async () => {
    const sink = memoryExporter()
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-observe-'))
    const odd = service('odd', {
      ratio: action.query({}, function* ({ ctx }) {
        // a hit ratio before the first hit, an unbounded limit: numbers JSON cannot spell
        yield* ctx.log.info('ratio', { ratio: 0 / 0, max: Infinity })
        yield* ctx.span(
          'inner',
          function* () {
            return 1
          },
          { attributes: { 'ozaco.probe.low': -Infinity, 'ozaco.probe.list': [1, Number.NaN] } },
        )

        return 'ok'
      }),
    })

    try {
      unwrap(
        await run(function* () {
          yield* storage()

          const server = yield* createServer({
            services: [odd],
            plugins: [
              ObservePlugin.use({
                db: SqliteAdapter.use({ path: join(dir, 'observe.sqlite') }),
                batch: { waitMs: 10 },
              }),
              sink.plugin,
            ],
          })

          yield* server.call(odd, 'ratio', {})

          const [root] = (yield* Observe.actions.traces({})).traces
          const view = (yield* Observe.actions.trace(root!.trace_id))!
          const inner = view.spans.find(span => span.name === 'inner')!
          const line = view.logs.find(log => log.body === 'ratio')!

          // std normalizes them ONCE, before any sink: every sink holds these strings
          expect(inner.attributes).toEqual({
            'ozaco.probe.low': '-Infinity',
            'ozaco.probe.list': ['1', 'NaN'],
          })
          expect(line.attributes).toEqual({ ratio: 'NaN', max: 'Infinity' })

          // decoded, they are the exporter's own events
          const exported = (name: string): AnyType =>
            sink.events.find(event =>
              event.t === 'span' ? event.span.name === name : event.log.body === name,
            )

          expect((eventOfSpanRow(inner) as AnyType).span.attributes).toEqual(
            exported('inner').span.attributes,
          )
          expect((eventOfLogRow(line) as AnyType).log.attributes).toEqual(
            exported('ratio').log.attributes,
          )
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
