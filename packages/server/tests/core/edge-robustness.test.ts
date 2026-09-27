/**
 * The edge's telemetry where things go wrong (design §6.2, §7 edge drivers): a streamed body that
 * breaks (sse ends cleanly on the wire, never silently in the trace; a thrown body error is
 * `server.internal`), a response the runtime refuses (one request, ONE edge span), an invalid
 * inbound `traceparent`, query input never captured as a "body", the first-frame authorizer
 * running INSIDE its frame span (one record), a crashing socket handler, clients that leave
 * before / during the response (the handler is cancelled, the feed stops, the span ends — on
 * node too) and headers node refuses (a 500, never a crashed process).
 */
import type { ServerDef } from 'server:core'
import { action, createServer, Edge, service, stream } from 'server:core'
import type { Operation } from 'std:effect'
import { flowOf, run, sleep, until } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { span } from 'std:trace'

import { describe, expect, it } from 'bun:test'
import { connect } from 'node:net'

import { BunEdge } from 'server:impl/edge/bun'
import { NodeEdge } from 'server:impl/edge/node'
import { z } from 'zod'

import { storage } from '../helpers'

/** How many values the endless feeds produced (a feed that keeps going after its client left
 * shows up here). */
let emitted = 0

/** What the slow action saw of its cancellation: `true` aborted/halted, `false` ran to the end. */
let cancelled: boolean | null = null

const endless = () =>
  flowOf<number>(function* (emit) {
    for (;;) {
      emitted += 1
      yield* emit(emitted)
      yield* sleep(10)
    }
  })

const feeds = service('feeds', {
  sse: action.stream({ output: stream.sse(z.number()) }, function* () {
    return flowOf<number>(function* (emit) {
      yield* emit(1)
      yield* sleep(10)
      return yield* fail('feeds.broke', 'the feed broke')
    })
  }),
  ndjson: action.stream({ output: stream.ndjson(z.number()) }, function* () {
    return flowOf<number>(function* (emit) {
      yield* emit(1)
      yield* sleep(10)
      return yield* fail('feeds.broke', 'the feed broke')
    })
  }),
  // headers only after 80ms: a client may be gone before they are written
  late: action.stream({ output: stream.sse(z.number()) }, function* () {
    yield* sleep(80)
    return endless()
  }),
  live: action.stream({ output: stream.sse(z.number()) }, function* () {
    return endless()
  }),
  slow: action.query({}, function* ({ ctx }) {
    cancelled = null

    try {
      yield* sleep(150)
      cancelled = ctx.signal.aborted
    } finally {
      cancelled ??= true
    }

    return 'late'
  }),
  read: action.query(
    {
      input: z.object({ id: z.string(), token: z.string().optional() }),
      route: { method: 'GET', path: '/feeds/read/:id' },
    },
    function* ({ input }) {
      return { id: input.id }
    },
  ),
  write: action.mutation({ input: z.object({ name: z.string() }) }, function* ({ input }) {
    return { name: input.name }
  }),
})

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

  const edgesOf = (path: string): TraceDef.SpanData[] =>
    spans.filter(item => item.kind === 'server' && item.attributes['url.path'] === path)

  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, edgesOf, exceptions }
}

type Spy = ReturnType<typeof spy>

/** Boot a node (`feeds` + `options`, the spy installed), run `body`, stop it. */
const withServer = async (
  options: Partial<ServerDef.Options>,
  body: (seen: Spy, server: ServerDef.Handle<AnyType>) => Operation<void>,
): Promise<Spy> => {
  const seen = spy()

  unwrap(
    await run(function* () {
      yield* storage()
      const server = yield* createServer({
        services: [feeds],
        edge: BunEdge,
        ...options,
        plugins: [seen.plugin.use(), ...(options.plugins ?? [])],
      })
      yield* body(seen, server)
      yield* server.stop()
    }),
  )

  return seen
}

/** One in-process request, its body read to the end (a failing body read is not an error here). */
function* request(path: string, init?: RequestInit): Operation<{ status: number; text: string }> {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))
  const text = yield* until(response.text().catch(() => '<body failed>'))
  // the span of a streamed body ends from the edge's scope: let that run
  yield* sleep(20)

  return { status: response.status, text }
}

describe('edge robustness — bodies that break', () => {
  it('an sse feed that breaks ends cleanly on the wire but fails the edge span — ONE record, where the feed ran', async () => {
    const seen = await withServer({}, function* () {
      const sse = yield* request('/feeds/sse')
      expect(sse.status).toBe(200)
      // the wire is unchanged: the feed simply ends
      expect(sse.text).toBe(': ok\n\ndata: 1\n\n')

      const ndjson = yield* request('/feeds/ndjson')
      expect(ndjson.text).toBe('<body failed>')
    })

    for (const path of ['/feeds/sse', '/feeds/ndjson']) {
      const [edge] = seen.edgesOf(path)
      expect(edge!.attributes['http.response.status_code']).toBe(200)
      expect(edge!.attributes['error.type']).toBe('feeds.broke')
      expect(edge!.status).toEqual({ code: 'error', message: 'the feed broke' })
      const records = seen
        .exceptions()
        .filter(log => log.context?.traceId === edge!.context.traceId)
      // the feed is produced inside its dispatch span (it stays open with the stream): the
      // failure is recorded THERE, once — the edge span only fails with it
      expect(records.map(log => [log.eventName, log.severityNumber])).toEqual([
        ['ozaco.action.exception', 17],
      ])
      const origin = seen.spans.find(item => item.context.spanId === records[0]!.context?.spanId)
      expect(origin?.name).toBe(`feeds.${path.slice('/feeds/'.length)}`)
      expect(origin?.parent?.spanId).toBe(edge!.context.spanId)
    }
  })

  it('a request body that is not JSON is `server.bad-request`, the SyntaxError ONE level under it', async () => {
    const seen = await withServer({}, function* () {
      const got = yield* request('/feeds/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      expect(got.status).toBe(400)
      expect(JSON.parse(got.text).error.error).toBe('server.bad-request')
    })

    const [edge] = seen.edgesOf('/feeds/write')
    expect(edge!.attributes['error.type']).toBe('server.bad-request')
    const records = seen.exceptions()
    expect(records).toHaveLength(1)
    // the parser's own error, folded (`std:result.unknown`), ONE level under it
    const chain = records[0]!.attributes['ozaco.failure.chain'] as string[]
    expect(chain).toHaveLength(2)
    expect(chain[0]).toBe('server.bad-request: request body is not valid JSON')
    expect(chain[1]).toStartWith('std:result.unknown: SyntaxError: ')
  })

  it('a raw body that throws mid-stream is `server.internal`, the error kept in the chain', async () => {
    const seen = await withServer({}, function* () {
      yield* Edge.actions.raw({
        method: 'GET',
        path: '/breaks',
        *handler() {
          let sent = false

          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent) {
                  controller.error(new TypeError('the disk went away'))
                  return
                }
                sent = true
                controller.enqueue(new TextEncoder().encode('part'))
              },
            }),
          )
        },
      })
      yield* request('/breaks')
    })

    const [edge] = seen.edgesOf('/breaks')
    expect(edge!.attributes['error.type']).toBe('server.internal')
    expect(edge!.status.code).toBe('error')
    const records = seen.exceptions()
    expect(records).toHaveLength(1)
    expect(records[0]!.attributes['ozaco.failure.chain']).toEqual([
      'server.internal: the response body failed',
      'std:result.unknown: TypeError: the disk went away',
    ])
  })

  it('a raw response the runtime refuses to re-wrap: a 500 from the SAME edge span', async () => {
    const seen = await withServer({ trace: { response: false } }, function* () {
      yield* Edge.actions.raw({
        method: 'GET',
        path: '/refused',
        *handler() {
          // status 0: no `Response` can be built from it again
          return Response.error()
        },
      })
      expect((yield* request('/refused')).status).toBe(500)
    })

    // one request, one edge span — never a second `HTTP` crash root next to it
    expect(seen.spans.filter(item => item.kind === 'server')).toHaveLength(1)
    const [edge] = seen.edgesOf('/refused')
    expect(edge!.name).toBe('GET /refused')
    expect(edge!.attributes['http.response.status_code']).toBe(500)
    expect(edge!.attributes['error.type']).toBe('server.internal')
    expect(seen.exceptions()).toHaveLength(1)
  })
})

describe('edge robustness — inbound context and capture', () => {
  it('an invalid traceparent is ignored: a new root, no link, no crash', async () => {
    const seen = await withServer({}, function* () {
      for (const traceparent of [
        '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01',
        '00-00000000000000000000000000000000-b7ad6b7169203331-01',
        'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        'garbage',
      ]) {
        expect((yield* request('/feeds/read/x', { headers: { traceparent } })).status).toBe(200)
      }
    })

    const edges = seen.edgesOf('/feeds/read/x')
    expect(edges).toHaveLength(4)

    for (const edge of edges) {
      expect(edge.parent).toBeNull()
      expect(edge.links).toHaveLength(0)
    }
  })

  it('query input is never captured as a request body (its values stay REDACTED)', async () => {
    const seen = await withServer({ observe: { capture: { bodies: true } } }, function* () {
      yield* request('/feeds/read/a42?token=secret-value')
      const payload = JSON.stringify({ name: 'ada' })
      yield* request('/feeds/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': `${payload.length}` },
        body: payload,
      })
    })

    const [read] = seen.edgesOf('/feeds/read/a42')
    expect(read!.attributes['url.query']).toBe('token=REDACTED')
    expect(read!.attributes['http.request.body.content']).toBeUndefined()
    expect(read!.attributes['http.request.body.size']).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain('secret-value')

    // a body the request really carried is captured, its size as sent
    const [written] = seen.edgesOf('/feeds/write')
    expect(written!.attributes).toMatchObject({
      'http.request.body.content': '{"name":"ada"}',
      'http.request.body.size': 14,
    })
  })
})

describe('edge robustness — sockets', () => {
  it('a first-frame authorizer runs INSIDE the auth frame span: its failure is recorded ONCE', async () => {
    const seen = spy()

    const guarded = service('guarded', {
      feed: action.socket(
        {
          authorizeMode: 'first-frame',
          *authorize(_request, token) {
            return yield* span('auth.verify', function* () {
              if (token !== 'good') {
                return yield* fail('server.unauthorized', 'bad token')
              }
              return { sub: 'ada' }
            })
          },
        },
        function* (socket) {
          yield* socket.send({ t: 'hello' })
          const messages = yield* socket.messages
          yield* messages.next()
        },
      ),
    })

    /** Dial, authorize with `token`, send one frame once greeted, resolve on close. */
    const dial = (url: string, token: string): Promise<number> =>
      new Promise(resolve => {
        const ws = new WebSocket(url)
        ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'auth', token })))
        ws.addEventListener('message', () => {
          ws.send(JSON.stringify({ t: 'say' }))
          setTimeout(() => ws.close(), 30)
        })
        ws.addEventListener('close', event => resolve(event.code))
      })

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [guarded],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
        })
        const info = yield* server.start({ port: 0 })
        const url = `${info.url!.replace('http', 'ws')}/guarded/feed`
        expect(yield* until(dial(url, 'bad'))).toBe(4401)
        expect(yield* until(dial(url, 'good'))).not.toBe(4401)
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    // the refused session: the authorizer's span nests under the auth frame's root span
    const verify = seen.spans.filter(item => item.name === 'auth.verify')
    expect(verify).toHaveLength(1)
    const frames = seen.spans.filter(item => item.name === 'WS /guarded/feed')
    const refused = frames.find(item => item.context.traceId === verify[0]!.context.traceId)
    expect(refused).toBeDefined()
    expect(verify[0]!.parent?.spanId).toBe(refused!.context.spanId)
    expect(refused!.attributes).toMatchObject({
      'error.type': 'server.unauthorized',
      'ozaco.ws.close.code': 4401,
    })
    expect(refused!.status.code).toBe('unset')

    // ONE record for the whole refusal — WARN, at its origin
    const records = seen.exceptions()
    expect(records).toHaveLength(1)
    expect(records[0]!.severityNumber).toBe(13)
    expect(records[0]!.context?.spanId).toBe(verify[0]!.context.spanId)

    // the accepted session: its auth frame leaves no span, its one call frame does
    expect(frames).toHaveLength(2)
    expect(frames.find(item => item !== refused)!.attributes['ozaco.ws.message.type']).toBe('say')
  })

  it('a first-frame authorizer that CRASHES is a server fault: ERROR, the span failed', async () => {
    const seen = spy()

    const broken = service('broken', {
      feed: action.socket(
        {
          authorizeMode: 'first-frame',
          *authorize() {
            throw new TypeError('the key store is down')
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
          services: [broken],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
        })
        const info = yield* server.start({ port: 0 })
        const code = yield* until(
          new Promise<number>(resolve => {
            const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/broken/feed`)
            ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'auth', token: 'x' })))
            ws.addEventListener('close', event => resolve(event.code))
          }),
        )
        expect(code).toBe(4401)
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    const refused = seen.spans.find(item => item.name === 'WS /broken/feed')
    expect(refused!.attributes['error.type']).toBe('server.internal')
    expect(refused!.status.code).toBe('error')
    const records = seen.exceptions()
    expect(records).toHaveLength(1)
    expect(records[0]!.severityNumber).toBe(17)
    expect(String(records[0]!.attributes['exception.stacktrace'])).toContain(
      'the key store is down',
    )
  })

  it('a socket handler that throws fails its frame span as `server.internal` (ERROR)', async () => {
    const seen = spy()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [feeds],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
        })
        yield* Edge.actions.socket({
          path: '/crash',
          *handler(socket) {
            yield* socket.send({ t: 'hello' })
            const messages = yield* socket.messages
            yield* messages.next()
            throw new TypeError('handler blew up')
          },
        })
        const info = yield* server.start({ port: 0 })
        yield* until(
          new Promise<void>(resolve => {
            const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/crash`)
            ws.addEventListener('message', () => ws.send(JSON.stringify({ t: 'go' })))
            ws.addEventListener('close', () => resolve())
            setTimeout(() => {
              ws.close()
              resolve()
            }, 150)
          }),
        )
        yield* sleep(50)
        yield* server.stop()
      }),
    )

    const frames = seen.spans.filter(item => item.name === 'WS /crash')
    expect(frames).toHaveLength(1)
    expect(frames[0]!.attributes['error.type']).toBe('server.internal')
    // the status message is std:trace's: the fold's message, same as `exception.message`
    expect(frames[0]!.status).toEqual({ code: 'error', message: 'TypeError: handler blew up' })
    const records = seen.exceptions()
    expect(records).toHaveLength(1)
    expect(records[0]!.severityNumber).toBe(17)
  })
})

/** The disconnect cases, over one edge runtime. */
const leaving = (label: string, edge: ServerDef.PluginLike): void => {
  it(`${label}: a client gone before the headers cancels the handler; nothing keeps running`, async () => {
    const seen = spy()
    let before = 0
    let after = 0

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [feeds],
          edge,
          plugins: [seen.plugin.use()],
        })
        const info = yield* server.start({ port: 0 })

        for (const path of ['/feeds/late', '/feeds/slow']) {
          const controller = new AbortController()
          const pending = fetch(`${info.url}${path}`, { signal: controller.signal }).catch(
            () => null,
          )
          yield* sleep(30)
          controller.abort()
          yield* until(pending)
        }

        yield* sleep(200)
        before = emitted
        yield* sleep(100)
        after = emitted
        yield* server.stop()
      }),
    )

    // the feed never started, the slow handler was cancelled (ctx.signal / halt)
    expect(after).toBe(before)
    expect(cancelled).toBe(true)

    for (const path of ['/feeds/late', '/feeds/slow']) {
      const spans = seen.edgesOf(path)
      expect(spans).toHaveLength(1)
      expect(spans[0]!.attributes).toMatchObject({
        'http.response.status_code': 499,
        'error.type': 'server.cancelled',
      })
    }
  })

  it(`${label}: a client gone mid-stream stops the feed and ends the span cancelled`, async () => {
    const seen = spy()
    let before = 0
    let after = 0

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [feeds],
          edge,
          plugins: [seen.plugin.use()],
        })
        const info = yield* server.start({ port: 0 })
        const controller = new AbortController()
        const response = yield* until(
          fetch(`${info.url}/feeds/live`, { signal: controller.signal }),
        )
        const reader = response.body!.getReader()
        yield* until(reader.read())
        yield* until(reader.read())
        controller.abort()
        yield* sleep(100)
        before = emitted
        yield* sleep(100)
        after = emitted
        yield* server.stop()
      }),
    )

    expect(after).toBe(before)
    const spans = seen.edgesOf('/feeds/live')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes['ozaco.cancelled']).toBe(true)
    expect(spans[0]!.status.code).toBe('unset')
  })
}

describe('edge robustness — clients that leave', () => {
  leaving('bun', BunEdge)
  leaving('node', NodeEdge)

  it('node: a header node refuses answers a plain 500 — the process never crashes', async () => {
    let status = 0

    await withServer({ edge: NodeEdge }, function* (_seen, server) {
      yield* Edge.actions.raw({
        method: 'GET',
        path: '/bad-header',
        *handler() {
          const headers = new Headers()
          // a web `Headers` allows it; node's `writeHead` throws on it
          headers.set('x-bad', 'a\u0001b')
          return new Response('body', { headers })
        },
      })
      const info = yield* server.start({ port: 0 })
      const response = yield* until(fetch(`${info.url}/bad-header`))
      status = response.status
      expect(yield* until(response.text())).toBe('internal error')
    })

    expect(status).toBe(500)
  })

  it('node: a refused upgrade answers its whole failure envelope', async () => {
    const gate = service('gate', {
      feed: action.socket(
        {
          *authorize() {
            return yield* fail('server.unauthorized', 'no entry')
          },
        },
        function* (socket) {
          yield* socket.send({ t: 'hello' })
        },
      ),
    })
    let raw = ''

    await withServer({ services: [gate], edge: NodeEdge }, function* (_seen, server) {
      const info = yield* server.start({ port: 0 })
      raw = yield* until(
        new Promise<string>(resolve => {
          const socket = connect(info.port!, '127.0.0.1')
          let data = ''
          socket.on('data', chunk => {
            data += chunk.toString('latin1')
          })
          socket.on('close', () => resolve(data))
          socket.on('error', () => resolve(data))
          socket.write(
            'GET /gate/feed HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n' +
              'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              'Sec-WebSocket-Version: 13\r\nAuthorization: Bearer x\r\n\r\n',
          )
        }),
      )
    })

    const [head, body = ''] = raw.split('\r\n\r\n')
    expect(head!.startsWith('HTTP/1.1 401')).toBe(true)
    expect(head).toContain('x-request-id: ')
    expect(head).toContain('oz-error: server.unauthorized')
    expect(Number(/content-length: (\d+)/iu.exec(head!)?.[1])).toBe(body.length)
    expect(JSON.parse(body).error).toMatchObject({ error: 'server.unauthorized', status: 401 })
  })
})
