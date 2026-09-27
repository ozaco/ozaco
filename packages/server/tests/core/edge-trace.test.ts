/**
 * The edge's telemetry (design §6.1/§6.2): the HTTP SERVER span `{METHOD} {route}` (routed
 * first, HTTP semconv attributes, `url.query` redacted), its status from the FINAL response only
 * (4xx unset + `error.type`, 5xx error), edge-originated failures recorded on it (DEBUG for a
 * 4xx), the inbound trace policy (link / continue / ignore, `trust`, `ozaco=1`), `traceresponse`
 * and the request-id rules, the span ending with a streamed BODY, `record: 'errors'` for
 * plugin-owned / quiet routes, the websocket upgrade span + one ROOT span per frame, captured
 * headers / bodies / frames (secrets redacted) and the failure envelope.
 */
import type { ServerDef } from 'server:core'
import { action, createServer, Edge, HEADERS, service, stream } from 'server:core'
import type { Operation } from 'std:effect'
import { flowOf, fork, run, scoped, sleep, until } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { inject } from 'std:trace'

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunEdge } from 'server:impl/edge/bun'
import { JsonCodec } from 'std:codec/impl/json'
import { z } from 'zod'

import { LABELS, storage } from '../helpers'

const INBOUND_TRACE = '0af7651916cd43dd8448eb211c80319c'
const INBOUND_SPAN = 'b7ad6b7169203331'
const PREVIOUS_SPAN = '00f067aa0ba902b7'
const traceparent = (flags = '01') => `00-${INBOUND_TRACE}-${INBOUND_SPAN}-${flags}`

const items = service('items', {
  get: action.query(
    {
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      route: { method: 'GET', path: '/items/:id' },
    },
    function* ({ input, ctx }) {
      yield* ctx.log.info('reading', { id: input.id })
      return { id: input.id }
    },
  ),
  put: action.mutation(
    { input: z.object({ name: z.string().min(1) }), output: z.object({ name: z.string() }) },
    function* ({ input }) {
      return { name: input.name }
    },
  ),
  boom: action.query({}, function* () {
    return yield* fail('items.kaput', 'kaput')
  }),
  thrown: action.query({}, function* () {
    throw new TypeError('the item exploded')
  }),
  chained: action.query({}, function* () {
    return yield* fail(
      'items.outer',
      'outer broke',
      'at: the outer step',
      fail('items.inner', 'inner broke'),
    )
  }),
  ticks: action.stream({ output: stream.ndjson(z.number()) }, function* () {
    return flowOf<number>(function* (emit) {
      for (let at = 0; at < 3; at += 1) {
        yield* sleep(20)
        yield* emit(at)
      }
    })
  }),
  /** A text stream: STRING chunks, multi-byte ones among them. */
  words: action.stream({ output: stream.text() }, function* () {
    return flowOf<string>(function* (emit) {
      for (const word of ['naïve ', 'café ', '日本 ', '🙂']) {
        yield* emit(word)
      }
    })
  }),
})

/** Secrets in and out: a login whose body and reply carry credentials at every depth, and a
 * multipart upload with a secret field. */
const vault = service('vault', {
  login: action.mutation(
    {
      input: z.object({
        email: z.string(),
        password: z.string(),
        profile: z.object({
          pin: z.string(),
          keys: z.array(z.object({ label: z.string(), Access_Token: z.string() })),
        }),
      }),
    },
    function* ({ input }) {
      return {
        user: { email: input.email, Session: { id: 'sess-9f' } },
        accessToken: 'tok-access-1',
        refreshToken: 'tok-refresh-1',
        grants: [{ scope: 'read', client_secret: 'cs-42' }],
      }
    },
  ),
  upload: action.mutation(
    {
      input: stream.parts({
        fields: z.object({ album: z.string(), apiKey: z.string() }),
        streams: { photo: stream.bytes('image/*') },
      }),
    },
    function* ({ input }) {
      const photo = yield* stream.flow(input.streams.photo)

      for (;;) {
        if ((yield* photo.next()).done) {
          return { album: input.fields.album }
        }
      }
    },
  ),
})

/** A plugin-owned service: its actions record only when they fail. */
const owned = service('owned', {
  ok: action.query({}, function* () {
    return 'ok'
  }),
  bad: action.query({}, function* () {
    return yield* fail('owned.bad', 'the plugin failed')
  }),
})

const Owning = definePlugin<ServerDef.PluginContext, []>({
  name: 'owning',
  version: '0',
  description: 'registers a service of its own',
  *setup() {
    return { services: [owned] }
  },
}).build()

/** An observe hook collecting every span and log record the kernel reports. */
const spy = () => {
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = definePlugin<ServerDef.PluginContext, []>({
    name: 'spy',
    version: '0',
    description: 'captures observe events',
    *setup() {
      const hooks: ServerDef.Hooks = {
        name: 'spy',
        *observe(event) {
          if (event.t === 'span') {
            spans.push(event.span)
          } else {
            logs.push(event.log)
          }
        },
      }
      return { hooks }
    },
  }).build()

  /** the edge (server) spans of the requests to `path`. */
  const edgesOf = (path: string): TraceDef.SpanData[] =>
    spans.filter(span => span.kind === 'server' && span.attributes['url.path'] === path)

  /** the ONE edge span of the request to `path`. */
  const edgeOf = (path: string): TraceDef.SpanData => {
    const found = edgesOf(path)
    expect(found).toHaveLength(1)
    return found[0]!
  }

  const inTrace = (traceId: string): TraceDef.SpanData[] =>
    spans.filter(span => span.context.traceId === traceId)

  /** exception records correlated to a trace. */
  const exceptionsIn = (traceId: string): TraceDef.LogData[] =>
    logs.filter(
      log => log.context?.traceId === traceId && log.attributes['exception.type'] !== undefined,
    )

  return { plugin, spans, logs, edgesOf, edgeOf, inTrace, exceptionsIn }
}

type Spy = ReturnType<typeof spy>

/** Boot a node with `items` (+ `options`), the spy installed, and run `body` against it. */
const withServer = async (
  options: Partial<ServerDef.Options>,
  body: (seen: Spy, server: ServerDef.Handle<AnyType>) => Operation<void>,
): Promise<Spy> => {
  const seen = spy()

  unwrap(
    await run(function* () {
      yield* storage()
      const server = yield* createServer({
        services: [items],
        edge: BunEdge,
        ...options,
        plugins: [seen.plugin.use(), ...(options.plugins ?? [])],
      })
      yield* server.start()
      yield* body(seen, server)
      yield* server.stop()
    }),
  )

  return seen
}

/** One in-process request, its body read to the end (the edge span ends with it). */
const request = function* (
  path: string,
  init?: RequestInit,
): Operation<{ status: number; headers: Headers; text: string; body: AnyType }> {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))
  const text = yield* until(response.text())
  // the span of a streamed body ends from the edge's scope: let that run
  yield* sleep(5)

  let body: AnyType = null

  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  return { status: response.status, headers: response.headers, text, body }
}

const site = mkdtempSync(join(tmpdir(), 'oz-edge-trace-'))
writeFileSync(join(site, 'app.js'), 'console.log(1)')

afterAll(() => {
  rmSync(site, { recursive: true, force: true })
})

describe('edge trace — the HTTP span', () => {
  it('is named by the route TEMPLATE and carries the HTTP semconv attributes', async () => {
    const seen = await withServer({}, function* () {
      const got = yield* request('/items/a42?token=secret&x=1', {
        headers: {
          'user-agent': 'probe/1.0',
          'x-forwarded-for': '203.0.113.9, 10.0.0.1',
          [HEADERS.requestId]: 'req-attrs',
        },
      })
      expect(got.status).toBe(200)
    })

    const edge = seen.edgeOf('/items/a42')
    expect(edge.name).toBe('GET /items/:id')
    expect(edge.kind).toBe('server')
    expect(edge.parent).toBeNull()
    expect(edge.scope.name).toBe('@ozaco/server')
    expect(edge.status.code).toBe('unset')
    expect(edge.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/items/:id',
      'url.path': '/items/a42',
      'url.scheme': 'http',
      'url.query': 'token=REDACTED&x=1',
      'server.address': 'edge',
      'server.port': 80,
      'user_agent.original': 'probe/1.0',
      'client.address': '203.0.113.9',
      'http.response.status_code': 200,
      'ozaco.request.id': 'req-attrs',
    })
    expect(edge.attributes['error.type']).toBeUndefined()

    // the dispatch nests under it; the handler's log line is correlated to the dispatch span
    const dispatch = seen.inTrace(edge.context.traceId).find(span => span.name === 'items.get')
    expect(dispatch?.parent?.spanId).toBe(edge.context.spanId)
    const line = seen.logs.find(log => log.body === 'reading')
    expect(line?.context?.spanId).toBe(dispatch?.context.spanId)
  })

  it('server.address: an IPv6 host without its brackets (as std fetch reports it)', async () => {
    const seen = await withServer({}, function* () {
      const v6 = yield* Edge.actions.handle(new Request('http://[::1]:8443/items/v6'))
      const v4 = yield* Edge.actions.handle(new Request('https://127.0.0.1/items/v4'))
      expect([v6.status, v4.status]).toEqual([200, 200])
      yield* until(Promise.all([v6.text(), v4.text()]))
      yield* sleep(5)
    })

    expect(seen.edgeOf('/items/v6').attributes).toMatchObject({
      'server.address': '::1',
      'server.port': 8443,
    })
    expect(seen.edgeOf('/items/v4').attributes).toMatchObject({
      'server.address': '127.0.0.1',
      'server.port': 443,
      'url.scheme': 'https',
    })
  })

  it('4xx: unset + error.type — DEBUG when edge-originated, WARN from an action', async () => {
    const seen = await withServer({}, function* () {
      expect((yield* request('/nowhere')).status).toBe(404)
      expect(
        (yield* request('/items/put', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '' }),
        })).status,
      ).toBe(400)
    })

    const unrouted = seen.edgeOf('/nowhere')
    expect(unrouted.name).toBe('GET')
    expect(unrouted.status.code).toBe('unset')
    expect(unrouted.attributes['error.type']).toBe('server.not-found')
    expect(unrouted.attributes['http.route']).toBeUndefined()
    const debug = seen.exceptionsIn(unrouted.context.traceId)
    expect(debug.map(log => [log.eventName, log.severityNumber])).toEqual([
      ['http.server.request.exception', 5],
    ])
    expect(unrouted.events.map(event => event.name)).toEqual(['exception'])

    const invalid = seen.edgeOf('/items/put')
    expect(invalid.status.code).toBe('unset')
    expect(invalid.attributes['error.type']).toBe('server.validation')
    // recorded at its origin (the dispatch span), never a second time on the edge span
    expect(invalid.events).toHaveLength(0)
    const warn = seen.exceptionsIn(invalid.context.traceId)
    expect(warn.map(log => [log.eventName, log.severityNumber])).toEqual([
      ['ozaco.action.exception', 13],
    ])
  })

  it('5xx: error on the edge span too — ONE ERROR record, at the origin', async () => {
    const seen = await withServer({}, function* () {
      const got = yield* request('/items/boom')
      expect(got.status).toBe(500)
    })

    const edge = seen.edgeOf('/items/boom')
    expect(edge.status).toEqual({ code: 'error', message: 'kaput' })
    expect(edge.attributes['error.type']).toBe('items.kaput')
    expect(edge.events).toHaveLength(0)
    const dispatch = seen.inTrace(edge.context.traceId).find(span => span.name === 'items.boom')
    expect(dispatch?.status.code).toBe('error')
    const records = seen.exceptionsIn(edge.context.traceId)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ eventName: 'ozaco.action.exception', severityNumber: 17 })
    expect(records[0]!.context?.spanId).toBe(dispatch?.context.spanId)
  })

  it("a thrown Error: the edge span's status message is the fold's, like the action span's", async () => {
    const seen = await withServer({}, function* () {
      const got = yield* request('/items/thrown')
      expect(got.status).toBe(500)
    })

    const edge = seen.edgeOf('/items/thrown')
    const dispatch = seen.inTrace(edge.context.traceId).find(span => span.name === 'items.thrown')
    expect(dispatch?.status).toEqual({ code: 'error', message: 'TypeError: the item exploded' })
    expect(edge.status).toEqual({ code: 'error', message: 'TypeError: the item exploded' })
    expect(edge.attributes['error.type']).toBe('server.internal')
  })

  it('a crash while answering is a 500 with the request id and ONE ERROR record', async () => {
    const seen = await withServer({}, function* () {
      yield* Edge.actions.decorate(function* () {
        throw new Error('the decorator broke')
      })
      const got = yield* request('/items/x7', { headers: { [HEADERS.requestId]: 'req-crash' } })
      expect(got.status).toBe(500)
      expect(got.headers.get(HEADERS.requestId)).toBe('req-crash')
      expect(got.body.error).toMatchObject({ error: 'server.internal', requestId: 'req-crash' })
    })

    const edge = seen.edgeOf('/items/x7')
    expect(edge.status.code).toBe('error')
    expect(edge.attributes['error.type']).toBe('server.internal')
    const records = seen.exceptionsIn(edge.context.traceId)
    expect(records).toHaveLength(1)
    expect(records[0]!.severityNumber).toBe(17)
    expect(records[0]!.eventName).toBe('http.server.request.exception')
    expect(String(records[0]!.attributes['exception.stacktrace'])).toContain('the decorator broke')
    // what crashed sits ONE level under `server.internal`: the thrown Error's fold
    expect(records[0]!.attributes['ozaco.failure.chain']).toEqual([
      'server.internal: the edge failed to answer',
      'std:result.unknown: Error: the decorator broke',
    ])
  })
})

describe('edge trace — inbound context, traceresponse, request ids', () => {
  it("'link' (default): a new root LINKING the inbound context — a `-00` one is still recorded", async () => {
    const seen = await withServer({}, function* () {
      for (const [path, flags] of [
        ['/items/sampled', '01'],
        ['/items/unsampled', '00'],
      ] as const) {
        const got = yield* request(path, { headers: { traceparent: traceparent(flags) } })
        expect(got.status).toBe(200)
      }
    })

    for (const path of ['/items/sampled', '/items/unsampled']) {
      const edge = seen.edgeOf(path)
      expect(edge.parent).toBeNull()
      expect(edge.context.traceId).not.toBe(INBOUND_TRACE)
      expect(edge.context.flags & 1).toBe(1)
      expect(edge.links).toHaveLength(1)
      expect(edge.links[0]!.context).toMatchObject({ traceId: INBOUND_TRACE, spanId: INBOUND_SPAN })
      expect(edge.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'remote.parent' })
    }
  })

  it("'continue' honours the inbound parent (and its sampled flag); 'ignore' drops it", async () => {
    const continued = await withServer({ trace: { inbound: 'continue' } }, function* () {
      yield* request('/items/one', { headers: { traceparent: traceparent() } })
      yield* request('/items/two', { headers: { traceparent: traceparent('00') } })
    })

    const edge = continued.edgeOf('/items/one')
    expect(edge.context.traceId).toBe(INBOUND_TRACE)
    expect(edge.parent).toMatchObject({ traceId: INBOUND_TRACE, spanId: INBOUND_SPAN })
    expect(edge.links).toHaveLength(0)
    // an unsampled parent, continued: nothing exported
    expect(continued.edgesOf('/items/two')).toHaveLength(0)

    const ignored = await withServer({ trace: { inbound: 'ignore' } }, function* () {
      yield* request('/items/three', { headers: { traceparent: traceparent() } })
    })

    const root = ignored.edgeOf('/items/three')
    expect(root.parent).toBeNull()
    expect(root.context.traceId).not.toBe(INBOUND_TRACE)
    expect(root.links).toHaveLength(0)
  })

  it('a trusted caller (`trust(request)` or `tracestate: ozaco=1`) is continued in link mode', async () => {
    const seen = await withServer(
      { trace: { trust: probe => probe.headers.get('x-internal') === 'yes' } },
      function* () {
        yield* request('/items/trusted', {
          headers: { traceparent: traceparent(), 'x-internal': 'yes' },
        })
        yield* request('/items/marked', {
          headers: { traceparent: traceparent(), tracestate: 'ozaco=1,vendor=x' },
        })
        yield* request('/items/stranger', { headers: { traceparent: traceparent() } })
      },
    )

    expect(seen.edgeOf('/items/trusted').parent?.spanId).toBe(INBOUND_SPAN)
    expect(seen.edgeOf('/items/marked').parent?.spanId).toBe(INBOUND_SPAN)
    expect(seen.edgeOf('/items/stranger').parent).toBeNull()
  })

  it('`ozaco=1` is self-asserted: a marked `-00` is continued AND recorded; only `trust` honours it', async () => {
    const answers: Record<string, Headers> = {}

    const seen = await withServer(
      { trace: { trust: probe => probe.headers.get('x-internal') === 'yes' } },
      function* () {
        // a stranger claiming to be an ozaco caller, asking this node to record nothing
        answers['marked'] = (yield* request('/items/marked', {
          headers: { traceparent: traceparent('00'), tracestate: 'ozaco=1' },
        })).headers
        // a caller the node trusts: its sampling decision stands
        answers['trusted'] = (yield* request('/items/trusted', {
          headers: { traceparent: traceparent('00'), 'x-internal': 'yes' },
        })).headers
        answers['both'] = (yield* request('/items/both', {
          headers: {
            traceparent: traceparent('00'),
            tracestate: 'ozaco=1',
            'x-internal': 'yes',
          },
        })).headers
      },
    )

    // continued (one trace between ozaco nodes) — but recorded here, and answered sampled
    const marked = seen.edgeOf('/items/marked')
    expect(marked.context.traceId).toBe(INBOUND_TRACE)
    expect(marked.parent?.spanId).toBe(INBOUND_SPAN)
    expect(marked.context.flags & 1).toBe(1)
    expect(marked.links).toHaveLength(0)
    expect(answers['marked']!.get(HEADERS.traceresponse)).toBe(
      `00-${INBOUND_TRACE}-${marked.context.spanId}-01`,
    )
    // the handler's work below it is recorded too
    expect(seen.inTrace(INBOUND_TRACE).map(span => span.name)).toContain('items.get')

    // trusted: the `-00` is honoured — nothing exported, the unsampled context answered
    expect(seen.edgesOf('/items/trusted')).toHaveLength(0)
    expect(seen.edgesOf('/items/both')).toHaveLength(0)
    expect(answers['trusted']!.get(HEADERS.traceresponse)).toMatch(
      new RegExp(`^00-${INBOUND_TRACE}-[0-9a-f]{16}-00$`, 'u'),
    )
  })

  it('never answers a trace that is not exported as sampled (`record: errors` successes, `off`)', async () => {
    const answers: Record<string, Headers> = {}

    const seen = await withServer({ plugins: [Owning.use()] }, function* () {
      yield* Edge.actions.raw({
        method: 'GET',
        path: '/quiet/:what',
        observe: 'errors',
        *handler(_request, params) {
          return params.what === 'ok'
            ? new Response('fine')
            : yield* fail('server.unavailable', 'the quiet route is down')
        },
      })
      yield* Edge.actions.raw({
        method: 'GET',
        path: '/off',
        observe: 'off',
        *handler() {
          return new Response('dark')
        },
      })
      yield* Edge.actions.static({ path: '/assets', dir: site })

      for (const path of [
        '/items/on',
        '/quiet/ok',
        '/quiet/down',
        '/owned/ok',
        '/owned/bad',
        '/assets/app.js',
        '/_health',
        '/off',
      ]) {
        answers[path] = (yield* request(path)).headers
      }
    })

    const flagsOf = (path: string): string | undefined =>
      answers[path]!.get(HEADERS.traceresponse)?.split('-')[3]

    // exported traces: sampled (+ the random flag of a trace minted here)
    expect(flagsOf('/items/on')).toBe('03')
    expect(flagsOf('/quiet/down')).toBe('03')
    expect(flagsOf('/owned/bad')).toBe('03')
    expect(seen.edgeOf('/quiet/down').context.traceId).toBe(
      answers['/quiet/down']!.get(HEADERS.traceresponse)!.split('-')[1]!,
    )

    // successes of quiet routes are dropped: their trace id is answered, never as sampled
    for (const path of ['/quiet/ok', '/owned/ok', '/assets/app.js', '/_health']) {
      expect(seen.edgesOf(path)).toHaveLength(0)
      expect(flagsOf(path)).toBe('02')
    }

    // an `off` route has no span at all: no traceresponse
    expect(answers['/off']!.get(HEADERS.traceresponse)).toBeNull()
    expect(answers['/off']!.get(HEADERS.requestId)).not.toBeNull()
  })

  it('answers `traceresponse` + `x-request-id`; request ids follow the rules', async () => {
    const answers: Record<string, { status: number; headers: Headers; body: AnyType }> = {}

    const seen = await withServer({}, function* () {
      answers['minted'] = yield* request('/items/minted')
      answers['given'] = yield* request('/items/given', {
        headers: { [HEADERS.requestId]: 'req-given' },
      })
      answers['invalid'] = yield* request('/items/invalid', {
        headers: { [HEADERS.requestId]: 'x'.repeat(200) },
      })
      answers['failed'] = yield* request('/items/chained', {
        headers: { [HEADERS.requestId]: 'req-failed' },
      })
    })

    // a new root minted here: the request id IS the trace id
    const minted = seen.edgeOf('/items/minted')
    expect(answers['minted']!.headers.get(HEADERS.requestId)).toBe(minted.context.traceId)
    expect(minted.attributes['ozaco.request.id']).toBeUndefined()
    // minted here: sampled + random flags
    expect(answers['minted']!.headers.get(HEADERS.traceresponse)).toBe(
      `00-${minted.context.traceId}-${minted.context.spanId}-03`,
    )

    // a valid inbound id wins (and is kept on the span); an invalid one is replaced
    expect(answers['given']!.headers.get(HEADERS.requestId)).toBe('req-given')
    expect(seen.edgeOf('/items/given').attributes['ozaco.request.id']).toBe('req-given')
    const invalid = seen.edgeOf('/items/invalid')
    expect(answers['invalid']!.headers.get(HEADERS.requestId)).toBe(invalid.context.traceId)

    // the failure envelope: tag, message, causes, status, ids — no `_d`, no chain by default;
    // the string causes are its own, the kernel's breadcrumb (the dispatch span, the request)
    // and the plugin runtime's labels
    const failed = seen.edgeOf('/items/chained')
    const dispatch = seen
      .inTrace(failed.context.traceId)
      .find(span => span.name === 'items.chained')
    expect(answers['failed']!.status).toBe(500)
    expect(answers['failed']!.body).toEqual({
      error: {
        error: 'items.outer',
        message: 'outer broke',
        causes: [
          'at: the outer step',
          `action:items.chained span:${dispatch!.context.spanId} req:req-failed`,
          ...LABELS.dispatch,
        ],
        status: 500,
        requestId: 'req-failed',
        traceId: failed.context.traceId,
      },
    })
  })

  it('`trace: { response: false }` answers neither header; continued requests mint their own id', async () => {
    let headers: Headers | null = null

    await withServer({ trace: { response: false } }, function* () {
      headers = (yield* request('/items/quiet')).headers
    })

    expect(headers!.get(HEADERS.traceresponse)).toBeNull()
    expect(headers!.get(HEADERS.requestId)).toBeNull()

    let continued: Headers | null = null

    const seen = await withServer({ trace: { inbound: 'continue' } }, function* () {
      continued = (yield* request('/items/continued', { headers: { traceparent: traceparent() } }))
        .headers
    })

    // the trace was not minted here: a fresh request id, never the (shared) trace id
    const edge = seen.edgeOf('/items/continued')
    const id = continued!.get(HEADERS.requestId)
    expect(id).toMatch(/^[0-9a-f]{32}$/u)
    expect(id).not.toBe(edge.context.traceId)
    // …and kept on the span, so the store finds the request by it
    expect(edge.attributes['ozaco.request.id']).toBe(id!)
    expect(continued!.get(HEADERS.traceresponse)).toBe(
      `00-${INBOUND_TRACE}-${edge.context.spanId}-01`,
    )
  })

  it('the chain is exposed with `errors.expose: chain` or to a caller `trust` accepts — never for `ozaco=1` alone', async () => {
    const bodies: AnyType[] = []
    let marked: AnyType = null

    await withServer({ errors: { expose: 'chain' } }, function* () {
      bodies.push((yield* request('/items/chained')).body)
    })

    const trusting = await withServer(
      { trace: { trust: probe => probe.headers.get('x-internal') === 'yes' } },
      function* () {
        bodies.push((yield* request('/items/chained', { headers: { 'x-internal': 'yes' } })).body)
        // the marker is self-asserted: anyone can send it
        marked = (yield* request('/items/chained', {
          headers: { traceparent: traceparent(), tracestate: 'ozaco=1' },
        })).body
      },
    )

    for (const body of bodies) {
      expect(body.error.error).toBe('items.outer')
      // the string cause stays a plain string; the wrapped failure is JsonCodec-tagged among them
      expect(body.error.causes[0]).toBe('at: the outer step')
      expect(body.error.causes[1]).toMatchObject({
        _t: 'std:result:failure',
        error: 'items.inner',
        message: 'inner broke',
        causes: [],
      })
      expect(body.error._d).toBeUndefined()
      expect(body.error.causes[1]._d).toBeUndefined()
    }

    expect(marked.error.error).toBe('items.outer')
    expect(marked.error.message).toBe('outer broke')
    // continued (never trusted): the breadcrumb names its dispatch span in the caller's trace
    const markedEdge = trusting
      .edgesOf('/items/chained')
      .find(span => span.context.traceId === INBOUND_TRACE)!
    const markedDispatch = trusting
      .inTrace(INBOUND_TRACE)
      .find(span => span.name === 'items.chained')!
    expect(marked.error.causes).toEqual([
      'at: the outer step',
      `action:items.chained span:${markedDispatch.context.spanId} req:${markedEdge.attributes['ozaco.request.id']}`,
      ...LABELS.dispatch,
    ])
    expect(JSON.stringify(marked)).not.toContain('inner broke')
  })

  it('an exposed chain decodes with the JsonCodec into real Failures — a thrown Error as its fold alone', async () => {
    const texts: string[] = []

    await withServer({ errors: { expose: 'chain' } }, function* () {
      const chained = yield* request('/items/chained')
      const thrown = yield* request('/items/thrown')
      texts.push(chained.text, thrown.text)
    })

    const decoded = unwrap(
      await run(function* () {
        yield* JsonCodec.use()
        const out: AnyType[] = []
        for (const text of texts) {
          out.push(yield* JsonCodec.actions.parse(text))
        }
        return out
      }),
    ) as AnyType[]

    const [chained, thrown] = decoded
    const inner = chained.error.causes[1]
    expect(isFailure(inner)).toBe(true)
    expect(inner).toMatchObject({ error: 'items.inner', message: 'inner broke' })

    // a thrown error is answered as `server.internal` with its fold's message — ONE level: the
    // Error itself (the fold's `raw`) never leaves the node, nor does its stack
    expect(thrown.error.error).toBe('server.internal')
    expect(thrown.error.message).toBe('TypeError: the item exploded')
    expect(thrown.error.causes.filter(isFailure)).toEqual([])
    expect(texts[1]).not.toContain('edge-trace.test')
  })
})

describe('edge trace — span lifetime and record modes', () => {
  it('a streamed body keeps the edge span open until the body is read', async () => {
    const seen = await withServer({}, function* (spyOf) {
      const response = yield* Edge.actions.handle(new Request('http://edge/items/ticks'))
      const headersAt = Date.now()
      yield* sleep(5)
      // the headers are out, the body is not: the span is still open
      expect(spyOf.edgesOf('/items/ticks')).toHaveLength(0)
      expect(yield* until(response.text())).toBe('0\n1\n2\n')
      yield* sleep(5)
      const edge = spyOf.edgeOf('/items/ticks')
      expect(edge.end).toBeGreaterThanOrEqual(headersAt + 30)
    })

    const edge = seen.edgeOf('/items/ticks')
    expect(edge.attributes['http.response.status_code']).toBe(200)
  })

  it("record: 'errors' drops a successful quiet request but keeps a failing one", async () => {
    const seen = await withServer({ plugins: [Owning.use()] }, function* () {
      yield* Edge.actions.raw({
        method: 'GET',
        path: '/quiet/:what',
        observe: 'errors',
        *handler(_request, params) {
          return params.what === 'ok'
            ? new Response('fine')
            : yield* fail('server.unavailable', 'the quiet route is down')
        },
      })
      yield* Edge.actions.raw({
        method: 'GET',
        path: '/off',
        observe: 'off',
        *handler() {
          return yield* fail('server.unavailable', 'never recorded')
        },
      })
      yield* Edge.actions.static({ path: '/assets', dir: site })

      expect((yield* request('/quiet/ok')).status).toBe(200)
      expect((yield* request('/quiet/down')).status).toBe(503)
      expect((yield* request('/owned/ok')).status).toBe(200)
      expect((yield* request('/owned/bad')).status).toBe(500)
      expect((yield* request('/assets/app.js')).status).toBe(200)
      expect((yield* request('/assets/missing.js')).status).toBe(404)
      expect((yield* request('/off')).status).toBe(503)
      // the kernel's own probe route is quiet too
      expect((yield* request('/_health')).status).toBe(200)
    })

    // successes of quiet routes leave nothing behind
    for (const path of ['/quiet/ok', '/owned/ok', '/assets/app.js', '/off', '/_health']) {
      expect(seen.edgesOf(path)).toHaveLength(0)
    }

    // failures surface with their whole local trace
    expect(seen.edgeOf('/quiet/down').attributes['error.type']).toBe('server.unavailable')
    const bad = seen.edgeOf('/owned/bad')
    expect(seen.inTrace(bad.context.traceId).map(span => span.name)).toContain('owned.bad')
    expect(seen.edgeOf('/assets/missing.js').name).toBe('GET /assets/**:path')
  })
})

describe('edge trace — captured headers and bodies', () => {
  it('captures headers (secrets REDACTED) and bodies when capture is on — never by default', async () => {
    const capture = { headers: true, bodies: true }
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
        cookie: 'session=abc',
        'x-custom': 'yes',
      },
      body: JSON.stringify({ name: 'ada' }),
    }

    const seen = await withServer({ observe: { capture } }, function* () {
      yield* request('/items/put', init)
      yield* request('/items/ticks')
      yield* request('/items/words')
    })

    const edge = seen.edgeOf('/items/put')
    expect(edge.attributes).toMatchObject({
      'http.request.header.authorization': ['REDACTED'],
      'http.request.header.cookie': ['REDACTED'],
      'http.request.header.x-custom': ['yes'],
      'http.request.body.content': '{"name":"ada"}',
      'http.request.body.size': 14,
      'http.response.body.content': '{"name":"ada"}',
    })
    expect(edge.attributes['http.response.header.x-request-id']).toEqual([edge.context.traceId])
    expect(JSON.stringify(edge)).not.toContain('secret-token')

    const streamed = seen.edgeOf('/items/ticks')
    expect(streamed.attributes['ozaco.response.body.kind']).toBe('flow')
    expect(streamed.attributes['http.response.body.size']).toBe(6)

    // a text stream's chunks are strings: counted in UTF-8 bytes (7 + 6 + 7 + 4), never NaN
    const text = seen.edgeOf('/items/words')
    expect(text.attributes['http.response.body.size']).toBe(24)

    const plain = await withServer({}, function* () {
      yield* request('/items/put', init)
    })

    const keys = Object.keys(plain.edgeOf('/items/put').attributes)
    expect(keys.some(key => key.startsWith('http.request.header.'))).toBe(false)
    expect(keys.some(key => key.includes('.body.'))).toBe(false)
  })
})

describe('edge trace — secrets never reach telemetry', () => {
  it('redacts secret keys at any depth in captured bodies and multipart fields', async () => {
    const login = {
      email: 'ada@example.com',
      password: 'hunter2',
      profile: { pin: '0000', keys: [{ label: 'ci', Access_Token: 'tok-inner' }] },
    }
    const form = new FormData()
    form.append('album', 'summer')
    form.append('apiKey', 'key-in-a-field')
    form.append('photo', new Blob([new Uint8Array(8)], { type: 'image/png' }), 'p.png')

    const seen = await withServer(
      { services: [items, vault], observe: { capture: { headers: true, bodies: true } } },
      function* () {
        const reply = yield* request('/vault/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(login),
        })
        expect(reply.body.accessToken).toBe('tok-access-1')
        expect((yield* request('/vault/upload', { method: 'POST', body: form })).status).toBe(200)
      },
    )

    const edge = seen.edgeOf('/vault/login')
    expect(JSON.parse(edge.attributes['http.request.body.content'] as string)).toEqual({
      email: 'ada@example.com',
      password: 'REDACTED',
      profile: { pin: 'REDACTED', keys: [{ label: 'ci', Access_Token: 'REDACTED' }] },
    })
    expect(JSON.parse(edge.attributes['http.response.body.content'] as string)).toEqual({
      user: { email: 'ada@example.com', Session: 'REDACTED' },
      accessToken: 'REDACTED',
      refreshToken: 'REDACTED',
      grants: [{ scope: 'read', client_secret: 'REDACTED' }],
    })
    // the size is what the body really weighed, not its redacted rendering
    expect(edge.attributes['http.request.body.size']).toBe(JSON.stringify(login).length)

    const upload = seen.edgeOf('/vault/upload')
    expect(upload.attributes['ozaco.request.body.kind']).toBe('parts')
    expect(JSON.parse(upload.attributes['http.request.body.content'] as string)).toEqual({
      album: 'summer',
      apiKey: 'REDACTED',
    })

    const everything = JSON.stringify(seen.spans)
    for (const secret of [
      'hunter2',
      '0000',
      'tok-inner',
      'tok-access-1',
      'tok-refresh-1',
      'sess-9f',
      'cs-42',
      'key-in-a-field',
    ]) {
      expect(everything).not.toContain(secret)
    }
  })

  it('redacts the query keys of the one secret list in `url.query`', async () => {
    const seen = await withServer({}, function* () {
      yield* request('/items/q1?refresh_token=r-1&Session=s-1&otp=123456&page=2')
    })

    expect(seen.edgeOf('/items/q1').attributes['url.query']).toBe(
      'refresh_token=REDACTED&Session=REDACTED&otp=REDACTED&page=2',
    )
  })
})

/** Dial a socket, send `frames` once it greets, collect `expect` replies, then close. */
const converse = (
  url: string,
  frames: readonly unknown[],
  replies: number,
): Promise<{ got: unknown[]; code: number }> =>
  new Promise((resolve, reject) => {
    const got: unknown[] = []
    const ws = new WebSocket(url)

    ws.addEventListener('message', event => {
      got.push(JSON.parse(String(event.data)))

      if (got.length === 1) {
        for (const frame of frames) {
          ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
        }
      }

      if (got.length === 1 + replies) {
        ws.close()
      }
    })
    ws.addEventListener('close', event => resolve({ got, code: event.code }))
    ws.addEventListener('error', () => reject(new Error('socket error')))
  })

describe('edge trace — websockets', () => {
  it('an upgrade span, then one ROOT span per frame linked to it; sends are events', async () => {
    const seen = spy()
    let heard: { got: unknown[]; code: number } | null = null
    const ctxSpans: string[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        yield* DefaultLogger.use({ level: LogLevel.info })
        const server = yield* createServer({
          services: [items],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
          observe: { capture: { frames: true } },
        })
        yield* Edge.actions.socket({
          path: '/live/:room',
          receives: z.object({ text: z.string() }),
          *handler(socket) {
            // a push outside any frame: counted, no span to put it on
            yield* socket.send({ t: 'hello' })
            const messages = yield* socket.messages

            for (;;) {
              const step = yield* messages.next()

              if (step.done) {
                return
              }

              const { text } = step.value as { text: string }
              ctxSpans.push(socket.ctx.trace.spanId)
              yield* socket.ctx.log.info('heard', { text })
              yield* socket.send({ t: 'echo', text })
            }
          },
        })
        const info = yield* server.start({ port: 0 })
        heard = yield* until(
          converse(
            `${info.url!.replace('http', 'ws')}/live/lobby`,
            [
              { t: 'say', text: 'a' },
              { t: 'say', text: 42 },
              { t: 'say', text: 'b' },
              { t: 'ping' },
            ],
            2,
          ),
        )
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    expect(heard!.got).toEqual([{ t: 'hello' }, { t: 'echo', text: 'a' }, { t: 'echo', text: 'b' }])

    const upgrade = seen.edgeOf('/live/lobby')
    expect(upgrade.name).toBe('GET /live/:room')
    expect(upgrade.attributes['http.response.status_code']).toBe(101)
    expect(upgrade.status.code).toBe('unset')
    // the session is searchable from its upgrade: the same id as every frame's
    expect(upgrade.attributes['ozaco.ws.session.id']).toMatch(/^[\da-f]{8}$/u)

    // one root span per frame (the ping is quiet), each linked to the upgrade span
    const frames = seen.spans
      .filter(span => span.name === 'WS /live/:room')
      .toSorted((left, right) => left.start - right.start)
    expect(frames).toHaveLength(3)
    const traces = new Set(frames.map(span => span.context.traceId))
    expect(traces.size).toBe(3)
    expect(traces.has(upgrade.context.traceId)).toBe(false)

    for (const frame of frames) {
      expect(frame.kind).toBe('server')
      expect(frame.parent).toBeNull()
      expect(frame.links).toHaveLength(1)
      expect(frame.links[0]!.context.spanId).toBe(upgrade.context.spanId)
      expect(frame.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'ws.session' })
      expect(frame.attributes['ozaco.ws.message.type']).toBe('say')
      expect(frame.attributes['http.route']).toBe('/live/:room')
      expect(frame.attributes['ozaco.ws.session.id']).toBe(
        upgrade.attributes['ozaco.ws.session.id'],
      )
    }

    const [first, malformed, last] = frames
    expect(first!.attributes['ozaco.ws.message.size']).toBe(
      JSON.stringify({ t: 'say', text: 'a' }).length,
    )
    expect(first!.attributes['ozaco.ws.message.body']).toBe('{"t":"say","text":"a"}')

    // the echo is an event on the frame it answers; the hello went out under no span
    for (const frame of [first!, last!]) {
      const sends = frame.events.filter(event => event.name === 'ozaco.ws.send')
      expect(sends).toHaveLength(1)
      expect(sends[0]!.attributes).toMatchObject({ 'ozaco.ws.message.type': 'echo' })
    }
    expect(JSON.stringify(seen.spans)).not.toContain('"ozaco.ws.message.type":"hello"')

    // the handler's log line — and `ctx.trace` — belong to the frame it handled
    expect(ctxSpans).toEqual([first!.context.spanId, last!.context.spanId])
    const lines = seen.logs.filter(log => log.body === 'heard')
    expect(lines.map(log => log.context?.spanId)).toEqual([
      first!.context.spanId,
      last!.context.spanId,
    ])

    // the malformed frame never reached the handler: a reject event + ONE WARN record
    expect(malformed!.events.map(event => event.name)).toContain('ozaco.ws.reject')
    expect(malformed!.attributes['error.type']).toBe('server.validation')
    const rejected = seen.exceptionsIn(malformed!.context.traceId)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.severityNumber).toBe(13)

    // the close: one INFO line, correlated to the upgrade span, with the session's totals
    const closed = seen.logs.filter(log => log.body === 'socket closed')
    expect(closed).toHaveLength(1)
    expect(closed[0]!.context?.spanId).toBe(upgrade.context.spanId)
    expect(closed[0]!.attributes).toMatchObject({
      'http.route': '/live/:room',
      'ozaco.ws.session.id': upgrade.attributes['ozaco.ws.session.id'],
      'ozaco.ws.messages.received': 4,
      'ozaco.ws.messages.sent': 3,
    })
  })

  it('a burst of frames starts its spans in arrival order, sub-millisecond, before their work', async () => {
    const seen = spy()
    const burst = Array.from({ length: 24 }, (_, at) => ({ t: 'say', text: `m${at}` }))

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [items],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
          observe: { capture: { frames: true } },
        })
        yield* Edge.actions.socket({
          path: '/burst',
          receives: z.object({ text: z.string() }),
          *handler(socket) {
            yield* socket.send({ t: 'hello' })
            const messages = yield* socket.messages

            for (;;) {
              const step = yield* messages.next()

              if (step.done) {
                return
              }

              yield* socket.ctx.log.info('heard', { text: (step.value as { text: string }).text })
              yield* socket.send({ t: 'echo' })
            }
          },
        })
        const info = yield* server.start({ port: 0 })
        yield* until(converse(`${info.url!.replace('http', 'ws')}/burst`, burst, burst.length))
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    // the frames as they arrived (their captured bodies), and their spans in start order: the
    // same order, every start distinct — a whole-millisecond `Date.now()` receipt stamp tied
    // frames of one burst, and their spans sorted any which way
    const frames = seen.spans.filter(span => span.name === 'WS /burst')
    expect(frames).toHaveLength(burst.length)
    const byStart = frames.toSorted((left, right) => left.start - right.start)
    expect(byStart.map(span => span.attributes['ozaco.ws.message.body'])).toEqual(
      burst.map(frame => JSON.stringify(frame)),
    )
    expect(new Set(frames.map(span => span.start)).size).toBe(burst.length)

    // each frame span starts on the clock its work reads: never after the line it logged
    for (const frame of frames) {
      const line = seen.logs.find(
        log => log.body === 'heard' && log.context?.spanId === frame.context.spanId,
      )
      expect(line).toBeDefined()
      expect(frame.start).toBeLessThanOrEqual(line!.time)
    }
  })

  it('work a frame starts in a forked task nests in its span; a captured frame redacts secrets', async () => {
    const seen = spy()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [items],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
          observe: { capture: { frames: true } },
        })
        yield* Edge.actions.socket({
          path: '/watch',
          *handler(socket) {
            yield* socket.send({ t: 'hello' })
            const messages = yield* socket.messages

            for (;;) {
              const step = yield* messages.next()

              if (step.done) {
                return
              }

              // what the realtime socket does: the watch runs as a task of its own, the handler
              // goes straight back for the next frame
              yield* fork(() =>
                scoped(() =>
                  socket.ctx.span('watch probe', function* () {
                    yield* sleep(5)
                    yield* socket.send({ t: 'sync' })
                  }),
                ),
              )
            }
          },
        })
        const info = yield* server.start({ port: 0 })
        yield* until(
          converse(
            `${info.url!.replace('http', 'ws')}/watch`,
            [{ t: 'watch', id: 'w1', auth: { token: 'tok-frame', nested: { password: 'pw' } } }],
            1,
          ),
        )
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    const frame = seen.spans.find(data => data.name === 'WS /watch')!
    const watch = seen.spans.find(data => data.name === 'watch probe')!
    expect(watch.parent?.spanId).toBe(frame.context.spanId)
    // the frame span is still open when the work it started opens its span
    expect(watch.start).toBeLessThanOrEqual(frame.end)

    expect(JSON.parse(frame.attributes['ozaco.ws.message.body'] as string)).toEqual({
      t: 'watch',
      id: 'w1',
      auth: { token: 'REDACTED', nested: { password: 'REDACTED' } },
    })
    expect(JSON.stringify(seen.spans)).not.toContain('tok-frame')
  })

  it("a frame's traceparent: continued when trusted, linked otherwise — never the handler's", async () => {
    const seen = spy()
    const delivered: unknown[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [items],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
        })
        yield* Edge.actions.socket({
          path: '/relay',
          *handler(socket) {
            yield* socket.send({ t: 'hello' })
            const messages = yield* socket.messages

            for (;;) {
              const step = yield* messages.next()

              if (step.done) {
                return
              }

              delivered.push(step.value)
              yield* socket.send({ t: 'ack' })
            }
          },
        })
        const info = yield* server.start({ port: 0 })
        yield* until(
          converse(
            `${info.url!.replace('http', 'ws')}/relay`,
            [
              { t: 'call', n: 1, traceparent: traceparent(), tracestate: 'ozaco=1' },
              { t: 'call', n: 2, traceparent: traceparent() },
              // re-sent after a reconnect: it names the previous socket generation
              {
                t: 'call',
                n: 3,
                traceparent: traceparent(),
                tracestate: 'ozaco=1',
                reconnect: `00-${INBOUND_TRACE}-${PREVIOUS_SPAN}-01`,
              },
              // a `reconnect` that is no traceparent is the handler's own field
              { t: 'call', n: 4, reconnect: 'soon' },
            ],
            4,
          ),
        )
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    // the transport's fields never reach the handler
    expect(delivered).toEqual([
      { t: 'call', n: 1 },
      { t: 'call', n: 2 },
      { t: 'call', n: 3 },
      { t: 'call', n: 4, reconnect: 'soon' },
    ])

    const upgrade = seen.edgeOf('/relay')
    const frames = seen.spans
      .filter(span => span.name === 'WS /relay')
      .toSorted((left, right) => left.start - right.start)
    expect(frames).toHaveLength(4)
    const [trusted, stranger, resent, plain] = frames

    // a re-sent frame LINKS the previous generation it names (`ws.reconnect`)
    expect(resent!.parent?.spanId).toBe(INBOUND_SPAN)
    expect(
      resent!.links.map(link => [link.context.spanId, link.attributes?.['ozaco.link.reason']]),
    ).toEqual([
      [upgrade.context.spanId, 'ws.session'],
      [PREVIOUS_SPAN, 'ws.reconnect'],
    ])
    expect(plain!.links.map(link => link.attributes?.['ozaco.link.reason'])).toEqual(['ws.session'])

    // an exporting ozaco caller (`ozaco=1`) is continued: its span is the frame's parent
    expect(trusted!.context.traceId).toBe(INBOUND_TRACE)
    expect(trusted!.parent?.spanId).toBe(INBOUND_SPAN)
    expect(trusted!.links.map(link => link.attributes?.['ozaco.link.reason'])).toEqual([
      'ws.session',
    ])

    // anyone else is linked (`trace.inbound` default `'link'`): a root of its own
    expect(stranger!.parent).toBeNull()
    expect(stranger!.context.traceId).not.toBe(INBOUND_TRACE)
    expect(
      stranger!.links.map(link => [link.context.spanId, link.attributes?.['ozaco.link.reason']]),
    ).toEqual([
      [upgrade.context.spanId, 'ws.session'],
      [INBOUND_SPAN, 'remote.parent'],
    ])
  })

  it("a frame's `-00`: recorded for a self-marked caller (`ozaco=1`), honoured only when `trust` accepts the upgrade", async () => {
    const seen = spy()
    const delivered: number[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [items],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
          trace: { trust: probe => new URL(probe.url).searchParams.get('internal') === 'yes' },
        })
        yield* Edge.actions.socket({
          path: '/relay',
          *handler(socket) {
            yield* socket.send({ t: 'hello' })
            const messages = yield* socket.messages

            for (;;) {
              const step = yield* messages.next()

              if (step.done) {
                return
              }

              delivered.push((step.value as { n: number }).n)
              yield* socket.send({ t: 'ack' })
            }
          },
        })
        const info = yield* server.start({ port: 0 })
        const base = `${info.url!.replace('http', 'ws')}/relay`
        const unsampled = { t: 'call', traceparent: traceparent('00'), tracestate: 'ozaco=1' }

        // anyone may mark itself: continued, but recorded here
        yield* until(converse(base, [{ ...unsampled, n: 1 }], 1))
        // an upgrade the node trusts: the frame's sampling decision stands
        yield* until(converse(`${base}?internal=yes`, [{ ...unsampled, n: 2 }], 1))
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    expect(delivered).toEqual([1, 2])
    const frames = seen.spans.filter(span => span.name === 'WS /relay')

    // only the marked stranger's frame is exported — continued, sampled
    expect(frames).toHaveLength(1)
    expect(frames[0]!.context.traceId).toBe(INBOUND_TRACE)
    expect(frames[0]!.parent?.spanId).toBe(INBOUND_SPAN)
    expect(frames[0]!.context.flags & 1).toBe(1)
  })

  it("tracing off: a frame's context rides on only when it would be continued (no laundering)", async () => {
    /** What a NON-observing node forwards (`inject()`, what its carrier hops carry) while it
     * handles each frame, under the given `trace.inbound`. */
    const forwarded = async (inbound?: 'link' | 'continue' | 'ignore') => {
      const carried: Record<string, string | null> = {}

      unwrap(
        await run(function* () {
          yield* storage()
          // no observe hook, no exporter: tracing is OFF on this node
          const server = yield* createServer({
            services: [items],
            edge: BunEdge,
            ...(inbound ? { trace: { inbound } } : {}),
          })
          yield* Edge.actions.socket({
            path: '/relay',
            *handler(socket) {
              yield* socket.send({ t: 'hello' })
              const messages = yield* socket.messages

              for (;;) {
                const step = yield* messages.next()

                if (step.done) {
                  return
                }

                const { who } = step.value as { who: string }
                carried[who] = (yield* inject()).traceparent ?? null
                yield* socket.send({ t: 'ack' })
              }
            },
          })
          const info = yield* server.start({ port: 0 })
          yield* until(
            converse(
              `${info.url!.replace('http', 'ws')}/relay`,
              [
                // an exporting ozaco caller: trusted, continued
                { who: 'ozaco', traceparent: traceparent('00'), tracestate: 'ozaco=1' },
                // anyone else, asking every node behind this one to record nothing (`-00`)
                { who: 'stranger', traceparent: traceparent('00') },
              ],
              2,
            ),
          )
          yield* server.stop()
        }),
      )

      return carried
    }

    const unsampled = traceparent('00')
    // `ozaco=1` is self-asserted: continued, but its `-00` is not honoured — it rides on sampled,
    // so the observing nodes behind this one still record
    const continued = traceparent('01')

    // 'link' (default) and 'ignore': the stranger's context stops here — its `-00` never
    // reaches the carriers (which always continue what they receive)
    expect(await forwarded()).toEqual({ ozaco: continued, stranger: null })
    expect(await forwarded('ignore')).toEqual({ ozaco: continued, stranger: null })
    // 'continue' (the operator's own choice): every inbound context is this node's parent, so
    // it rides on as received
    expect(await forwarded('continue')).toEqual({ ozaco: unsampled, stranger: unsampled })
  })

  it('a failed first-frame authorization is recorded (WARN) with its own causes kept', async () => {
    const seen = spy()
    let result: { got: unknown[]; code: number } | null = null

    const guarded = service('guarded', {
      feed: action.socket(
        {
          authorizeMode: 'first-frame',
          *authorize(_request, token) {
            if (token !== 'good') {
              return yield* fail('server.unauthorized', 'bad token', 'test.token-check')
            }
            return { sub: 'ada' }
          },
        },
        function* (socket) {
          yield* socket.send({ t: 'hello' })
        },
      ),
    })

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [guarded],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
          observe: { capture: { frames: true } },
        })
        const info = yield* server.start({ port: 0 })
        result = yield* until(
          new Promise<{ got: unknown[]; code: number }>(resolve => {
            const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/guarded/feed`)
            ws.addEventListener('open', () =>
              ws.send(JSON.stringify({ t: 'auth', token: 'sekrit-token' })),
            )
            ws.addEventListener('close', event => resolve({ got: [], code: event.code }))
          }),
        )
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    expect(result!.code).toBe(4401)
    const upgrade = seen.edgeOf('/guarded/feed')
    expect(upgrade.attributes['http.response.status_code']).toBe(101)

    const refused = seen.spans.filter(span => span.name === 'WS /guarded/feed')
    expect(refused).toHaveLength(1)
    expect(refused[0]!.attributes).toMatchObject({
      'error.type': 'server.unauthorized',
      'ozaco.ws.message.type': 'auth',
      'ozaco.ws.close.code': 4401,
    })
    expect(refused[0]!.links[0]!.context.spanId).toBe(upgrade.context.spanId)
    // frames are captured — never an auth frame's token
    expect(JSON.stringify(seen.spans)).not.toContain('sekrit-token')
    const records = seen.exceptionsIn(refused[0]!.context.traceId)
    expect(records).toHaveLength(1)
    expect(records[0]!.severityNumber).toBe(13)
    // the verdict's own cause survives; the first-frame cause is appended
    expect(records[0]!.attributes['ozaco.failure.causes']).toEqual([
      'test.token-check',
      'server:auth.first-frame',
    ])
  })
})
