/**
 * CORS telemetry (design §7): the decorators run INSIDE the edge span, so every cross-origin
 * request's verdict lands on it — `ozaco.cors.preflight`, `ozaco.cors.allowed` — and a request the
 * browser will refuse leaves one `cors.reject` event `{ ozaco.cors.reason }` (`origin`, or a
 * preflighted `method` / `headers` the answer does not allow). Same-origin and origin-less requests
 * are no CORS requests: nothing is said. The answers themselves are unchanged.
 */
import { createServer, Edge, HEADERS } from 'server:core'
import type { CorsDef } from 'server:plugins'
import { Cors } from 'server:plugins'
import type { Operation } from 'std:effect'
import { run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todos } from '../helpers'

let installs = 0

/** An in-memory std:trace `Trace` sink installed around the server: every exported span. */
const memoryTracer = () => {
  installs += 1

  const spans: TraceDef.SpanData[] = []

  const plugin = Trace.implement({
    name: `test/cors-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* Trace.actions.enableTracing()

      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit() {},
  })

  /** the edge (server) span of the ONE request tagged `probe` (its `x-request-id`). */
  const edgeOf = (probe: string): TraceDef.SpanData => {
    const found = spans.filter(
      data => data.kind === 'server' && data.attributes['ozaco.request.id'] === probe,
    )

    expect(found).toHaveLength(1)

    return found[0]!
  }

  return { plugin, spans, edgeOf }
}

type Memory = ReturnType<typeof memoryTracer>

/** Boot a node with `todos` + Cors under the in-memory tracer and run `body` against it. */
const withCors = async (options: CorsDef.Options, body: () => Operation<void>): Promise<Memory> => {
  const memory = memoryTracer()

  unwrap(
    await run(function* () {
      yield* storage()
      yield* memory.plugin.use()

      const server = yield* createServer({
        services: [todos],
        edge: BunEdge,
        plugins: [Cors.use(options)],
      })

      yield* server.start()
      yield* body()
      yield* server.stop()
    }),
  )

  return memory
}

/** One in-process request tagged `probe` (its `x-request-id`), its body read to the end. */
function* request(
  probe: string,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Operation<Response> {
  const response = yield* Edge.actions.handle(
    new Request(`http://edge${path}`, {
      method: init.method ?? 'GET',
      headers: { [HEADERS.requestId]: probe, ...init.headers },
    }),
  )

  yield* until(response.arrayBuffer())
  yield* sleep(5)

  return response
}

const APP = 'https://app.test'

/** The CORS attributes + reject events an edge span carries. */
const corsOf = (data: TraceDef.SpanData) => ({
  preflight: data.attributes['ozaco.cors.preflight'],
  allowed: data.attributes['ozaco.cors.allowed'],
  rejects: data.events
    .filter(item => item.name === 'cors.reject')
    .map(item => item.attributes?.['ozaco.cors.reason']),
})

describe('cors trace — the verdict on the edge span', () => {
  it('actual requests: allowed, or refused by origin (served, but without allow headers)', async () => {
    const memory = await withCors({ origins: [APP] }, function* () {
      const allowed = yield* request('allowed', '/todos/list', { headers: { origin: APP } })

      expect(allowed.headers.get('access-control-allow-origin')).toBe(APP)

      const foreign = yield* request('foreign', '/todos/list', {
        headers: { origin: 'https://evil.test' },
      })

      expect(foreign.status).toBe(200)
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull()

      // an error answer is decorated — and noted — too
      const missing = yield* request('missing', '/nope', { headers: { origin: APP } })

      expect(missing.status).toBe(404)
    })

    expect(corsOf(memory.edgeOf('allowed'))).toEqual({
      preflight: false,
      allowed: true,
      rejects: [],
    })
    expect(corsOf(memory.edgeOf('foreign'))).toEqual({
      preflight: false,
      allowed: false,
      rejects: ['origin'],
    })
    expect(corsOf(memory.edgeOf('missing'))).toEqual({
      preflight: false,
      allowed: true,
      rejects: [],
    })
    // a refusal is no failure of the request: the span says nothing is wrong with it
    expect(memory.edgeOf('foreign').status.code).toBe('unset')
    expect(memory.edgeOf('foreign').attributes['error.type']).toBeUndefined()
  })

  it('preflights: allowed, refused origin (the edge 404), method or headers the answer lacks', async () => {
    const memory = await withCors({ origins: [APP] }, function* () {
      const preflight = (probe: string, headers: Record<string, string>) =>
        request(probe, '/todos/create', {
          method: 'OPTIONS',
          headers: { origin: APP, 'access-control-request-method': 'POST', ...headers },
        })

      // the defaults let W3C trace context through
      const traced = yield* preflight('traced', {
        'access-control-request-headers': 'content-type, traceparent, tracestate',
      })

      expect(traced.status).toBe(204)

      const allowHeaders = traced.headers.get('access-control-allow-headers') ?? ''

      expect(allowHeaders).toContain('traceparent')
      expect(allowHeaders).toContain('tracestate')

      const foreign = yield* preflight('foreign', { origin: 'https://evil.test' })

      expect(foreign.status).toBe(404)

      // the answer is unchanged (the browser decides) — the telemetry says it will refuse
      const method = yield* preflight('method', { 'access-control-request-method': 'PURGE' })

      expect(method.status).toBe(204)

      const headers = yield* preflight('headers', {
        'access-control-request-headers': 'content-type, x-secret',
      })

      expect(headers.status).toBe(204)
    })

    expect(corsOf(memory.edgeOf('traced'))).toEqual({
      preflight: true,
      allowed: true,
      rejects: [],
    })

    const foreign = memory.edgeOf('foreign')

    expect(corsOf(foreign)).toEqual({ preflight: true, allowed: false, rejects: ['origin'] })
    // the unanswered preflight is the edge's own 404, recorded on the span as always
    expect(foreign.attributes['http.response.status_code']).toBe(404)
    expect(corsOf(memory.edgeOf('method'))).toEqual({
      preflight: true,
      allowed: false,
      rejects: ['method'],
    })
    expect(corsOf(memory.edgeOf('headers'))).toEqual({
      preflight: true,
      allowed: false,
      rejects: ['headers'],
    })
  })

  it('same-origin and origin-less requests are no CORS requests: nothing is said', async () => {
    const memory = await withCors({ origins: [APP] }, function* () {
      yield* request('plain', '/todos/list')
      yield* request('self', '/todos/list', { headers: { origin: 'http://edge' } })
      yield* request('fetch-metadata', '/todos/list', {
        headers: { origin: 'https://api.example', 'sec-fetch-site': 'same-origin' },
      })
    })

    for (const probe of ['plain', 'self', 'fetch-metadata']) {
      expect(corsOf(memory.edgeOf(probe))).toEqual({
        preflight: undefined,
        allowed: undefined,
        rejects: [],
      })
    }
  })

  it('a wildcard answer: any origin; `*` headers cover all but authorization', async () => {
    const memory = await withCors({ headers: ['*'] }, function* () {
      yield* request('any', '/todos/list', { headers: { origin: 'https://anyone.test' } })
      yield* request('wild', '/todos/create', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://anyone.test',
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'x-anything',
        },
      })
      yield* request('bearer', '/todos/create', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://anyone.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization',
        },
      })
    })

    expect(corsOf(memory.edgeOf('any')).allowed).toBe(true)
    expect(corsOf(memory.edgeOf('wild')).allowed).toBe(true)
    expect(corsOf(memory.edgeOf('bearer')).rejects).toEqual(['headers'])
  })
})
