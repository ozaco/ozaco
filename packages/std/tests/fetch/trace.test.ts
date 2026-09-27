import type { Operation } from 'std:effect'
import { race, run, sleep } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { Fetch, FetchClient, FetchErrors, fetchImpl, redactQuery, redactUrl } from 'std:fetch'
import { ResultErrors, isFailure, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import {
  ActiveSpan,
  enableTracing,
  extract,
  parseTraceparent,
  passThrough,
  span,
  suppressed,
  traceparentOf,
} from 'std:trace'

import { afterAll, describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import pkg from '../../package.json'
import { memoryTracer, traced, tracedResult } from '../trace/helpers'

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url)

    if (pathname === '/json') {
      return Response.json({ ok: true })
    }

    if (pathname === '/headers') {
      return Response.json({
        traceparent: req.headers.get('traceparent'),
        tracestate: req.headers.get('tracestate'),
      })
    }

    if (pathname === '/missing') {
      return new Response('nope', { status: 404, statusText: 'Not Found' })
    }

    if (pathname === '/broken') {
      return new Response('boom', { status: 503 })
    }

    if (pathname === '/empty') {
      return new Response(null, { status: 204 })
    }

    if (pathname === '/garbage') {
      return new Response('not json', { headers: { 'content-type': 'application/json' } })
    }

    if (pathname === '/slow') {
      await Bun.sleep(400)
      return new Response('late')
    }

    if (pathname === '/stream') {
      const encoder = new TextEncoder()
      const chunks = ['a', 'b', 'c']
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const chunk = chunks.shift()
            if (chunk === undefined) {
              controller.close()
              return
            }
            controller.enqueue(encoder.encode(chunk))
            await Bun.sleep(5)
          },
        }),
      )
    }

    if (pathname === '/drip') {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('first'))
            await Bun.sleep(400)
            controller.close()
          },
        }),
      )
    }

    return new Response('fallthrough')
  },
})

const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

const INBOUND = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/** A transport that records the request it was handed and answers `response()`. */
const capture = (response: () => Response = () => new Response('ok')) => {
  const seen: { url?: string; headers?: Headers } = {}

  const impl: FetchDef.Impl = (input, init) => {
    seen.url = input instanceof Request ? input.url : String(input)
    seen.headers = new Headers(init?.headers)
    return Promise.resolve(response())
  }

  return { seen, impl }
}

/** The CLIENT spans in the order they started (a body never read ends them all at scope close,
 * LIFO) — run them under one parent so they share its anchored clock. */
const byStart = (spans: readonly TraceDef.SpanData[]): TraceDef.SpanData[] =>
  spans.filter(data => data.kind === 'client').toSorted((left, right) => left.start - right.start)

/** Run `body` with `impl` as the transport. */
const through = <T>(impl: FetchDef.Impl, body: () => Operation<T>): Operation<T> =>
  fetchImpl.with(impl, body)

describe('fetch CLIENT span', () => {
  it('names the span {METHOD}, kind client, scope @ozaco/std/fetch, http client attributes', async () => {
    const { tracer, value } = await traced(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/json`)
      return yield* response.json()
    })

    expect(value).toEqual({ ok: true })

    const data = tracer.span('GET')
    expect(data.kind).toBe('client')
    expect(data.scope).toEqual({ name: '@ozaco/std/fetch', version: pkg.version })
    expect(data.parent).toBeNull()
    expect(data.status).toEqual({ code: 'unset' })
    expect(data.attributes).toEqual({
      'http.request.method': 'GET',
      'url.full': `${base}/json`,
      'server.address': '127.0.0.1',
      'server.port': Number(server.port),
      'http.response.status_code': 200,
    })
    expect(tracer.logs).toEqual([])
  })

  it('a template names the span {METHOD} {template} and sets url.template', async () => {
    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.post(`${base}/json`, {
        body: '{}',
        template: '/json',
      })
      return yield* response.text()
    })

    const data = tracer.span('POST /json')
    expect(data.attributes['url.template']).toBe('/json')
    expect(data.attributes['http.request.method']).toBe('POST')
  })

  it('nests under the active span; the parent is untouched', async () => {
    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* span('parent', function* () {
        const response = yield* Fetch.actions.get(`${base}/json`)
        return yield* response.json()
      })
    })

    const parent = tracer.span('parent')
    const child = tracer.span('GET')
    expect(child.context.traceId).toBe(parent.context.traceId)
    expect(child.parent?.spanId).toBe(parent.context.spanId)
    expect(parent.status).toEqual({ code: 'unset' })
    expect(parent.attributes).toEqual({})
  })

  it('methods: the Fetch-normalized six are uppercased, unknown ones are _OTHER named HTTP', async () => {
    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* span('batch', () =>
        through(capture().impl, function* () {
          yield* Fetch.actions.request(`${base}/a`, { method: 'get' })
          yield* Fetch.actions.request(`${base}/b`, { method: 'PROPFIND', template: '/b' })
          yield* Fetch.actions.request(`${base}/c`, { method: 'patch' })
          yield* Fetch.actions.patch(`${base}/d`)
        }),
      )
    })

    const [get, propfind, lower, patch] = byStart(tracer.spans)
    expect([get, propfind, lower, patch].map(data => data?.name)).toEqual([
      'GET',
      'HTTP /b',
      'HTTP',
      'PATCH',
    ])
    expect(get!.attributes['http.request.method']).toBe('GET')
    expect(get!.attributes['http.request.method_original']).toBeUndefined()
    expect(propfind!.attributes['http.request.method']).toBe('_OTHER')
    expect(propfind!.attributes['http.request.method_original']).toBe('PROPFIND')
    // `patch` is sent as is (Fetch does not normalize it) and is no exact known method
    expect(lower!.attributes['http.request.method']).toBe('_OTHER')
    expect(lower!.attributes['http.request.method_original']).toBe('patch')
    expect(patch!.attributes['http.request.method']).toBe('PATCH')
  })

  it('resendCount > 0 sets http.request.resend_count; the option never reaches the platform', async () => {
    const seen: RequestInit[] = []
    const impl: FetchDef.Impl = (_input, init) => {
      seen.push(init ?? {})
      return Promise.resolve(new Response('ok'))
    }

    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* span('batch', () =>
        through(impl, function* () {
          yield* Fetch.actions.get(`${base}/a`, { resendCount: 0, template: '/a' })
          yield* Fetch.actions.get(`${base}/a`, { resendCount: 2, template: '/a', propagate: true })
        }),
      )
    })

    const [first, second] = byStart(tracer.spans)
    expect(first!.attributes['http.request.resend_count']).toBeUndefined()
    expect(second!.attributes['http.request.resend_count']).toBe(2)

    for (const init of seen) {
      expect(Object.keys(init)).not.toContain('template')
      expect(Object.keys(init)).not.toContain('resendCount')
      expect(Object.keys(init)).not.toContain('propagate')
    }
  })

  it('server.port falls back to the scheme default; IPv6 hosts lose their brackets', async () => {
    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* span('batch', () =>
        through(capture().impl, function* () {
          yield* Fetch.actions.get('https://api.example.com/v1')
          yield* Fetch.actions.get('http://[::1]:8080/x')
        }),
      )
    })

    const [https, ipv6] = byStart(tracer.spans)
    expect(https!.attributes['server.address']).toBe('api.example.com')
    expect(https!.attributes['server.port']).toBe(443)
    expect(ipv6!.attributes['server.address']).toBe('::1')
    expect(ipv6!.attributes['server.port']).toBe(8080)
  })
})

describe('url.full redaction', () => {
  it('credentials become REDACTED:REDACTED, sensitive query values REDACTED', async () => {
    const url =
      'https://user:secret@bucket.s3.example.com/key.txt?X-Amz-Signature=abc&x-amz-credential=AKIA%2F1&X-Amz-Security-Token=t&keep=1&api_key=zzz&Token=q#frag'
    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* through(capture().impl, () => Fetch.actions.get(url))
    })

    expect(tracer.span('GET').attributes['url.full']).toBe(
      'https://REDACTED:REDACTED@bucket.s3.example.com/key.txt?X-Amz-Signature=REDACTED&x-amz-credential=REDACTED&X-Amz-Security-Token=REDACTED&keep=1&api_key=REDACTED&Token=REDACTED#frag',
    )
  })

  it('redactUrl / redactQuery keep everything else byte for byte', () => {
    expect(redactUrl('http://host/p?a=1&sig=x&b=%20+&flag')).toBe(
      'http://host/p?a=1&sig=REDACTED&b=%20+&flag',
    )
    expect(redactUrl('http://user@host/p')).toBe('http://REDACTED:REDACTED@host/p')
    expect(redactUrl('http://host/path@not-userinfo')).toBe('http://host/path@not-userinfo')
    expect(redactUrl('/relative?key=abc')).toBe('/relative?key=REDACTED')
    expect(redactUrl('http://host/cb#access_token=abc&state=1')).toBe(
      'http://host/cb#access_token=REDACTED&state=1',
    )
    expect(redactUrl('http://host/p?AWSAccessKeyId=a&Signature=b&X-Goog-Signature=c')).toBe(
      'http://host/p?AWSAccessKeyId=REDACTED&Signature=REDACTED&X-Goog-Signature=REDACTED',
    )

    expect(redactQuery('password=hunter2&user=me')).toBe('password=REDACTED&user=me')
    expect(redactQuery('?apikey=1&secret=2&access_token=3')).toBe(
      '?apikey=REDACTED&secret=REDACTED&access_token=REDACTED',
    )
    // an encoded key is matched decoded; its raw spelling is kept
    expect(redactQuery('api%5Fkey=1')).toBe('api%5Fkey=REDACTED')
    expect(redactQuery('')).toBe('')
    expect(redactQuery('?')).toBe('?')
  })
})

describe('status', () => {
  it('a 404 fails the CLIENT span: error status, error.type "404", no exception record', async () => {
    const { tracer, value } = await traced(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/missing`)
      return { status: response.status, text: yield* response.text() }
    })

    expect(value).toEqual({ status: 404, text: 'nope' })

    const data = tracer.span('GET')
    expect(data.status).toEqual({ code: 'error' })
    expect(data.attributes['http.response.status_code']).toBe(404)
    expect(data.attributes['error.type']).toBe('404')
    expect(tracer.exceptions()).toEqual([])
  })

  it('a 5xx fails it the same way', async () => {
    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/broken`)
      return yield* response.text()
    })

    const data = tracer.span('GET')
    expect(data.status).toEqual({ code: 'error' })
    expect(data.attributes['error.type']).toBe('503')
  })
})

describe('failures', () => {
  it('a transport fault: the FetchErrors tag as error.type, one http.client.request.exception', async () => {
    const refused: FetchDef.Impl = () =>
      Promise.reject(Object.assign(new TypeError('fetch failed'), { code: 'ConnectionRefused' }))

    const { tracer, result } = await tracedResult(function* () {
      yield* FetchClient.use()

      return yield* through(refused, () => Fetch.actions.get(`${base}/json`, { template: '/json' }))
    })

    expect(isFailure(result)).toBe(true)
    if (!isFailure(result)) {
      return
    }
    expect(result.error).toBe(FetchErrors.Network)

    const data = tracer.span('GET /json')
    expect(data.status.code).toBe('error')
    expect(data.attributes['error.type']).toBe(FetchErrors.Network)
    expect(data.attributes['http.response.status_code']).toBeUndefined()
    expect(data.events.map(event => event.name)).toEqual(['exception'])

    const [log, ...rest] = tracer.exceptions()
    expect(rest).toEqual([])
    expect(log!.eventName).toBe('http.client.request.exception')
    expect(log!.context?.spanId).toBe(data.context.spanId)
    expect(log!.attributes['exception.type']).toBe(FetchErrors.Network)
    // one level: the platform error is the failure's raw, never rendered
    expect(log!.attributes['ozaco.failure.chain']).toEqual(['std:fetch.network: ConnectionRefused'])
  })

  it('a real refused connection is a network failure on the span', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response('') })
    const url = `http://127.0.0.1:${closed.port}/gone`
    closed.stop(true)

    const { tracer, result } = await tracedResult(function* () {
      yield* FetchClient.use()
      return yield* Fetch.actions.get(url)
    })

    expect(isFailure(result) && result.error).toBe(FetchErrors.Network)
    expect(tracer.span('GET').attributes['error.type']).toBe(FetchErrors.Network)
  })

  it('a timeout fails the span with FetchErrors.Timeout', async () => {
    const { tracer, result } = await tracedResult(function* () {
      yield* FetchClient.use()
      return yield* Fetch.actions.get(`${base}/slow`, { timeoutMs: 30 })
    })

    expect(isFailure(result) && result.error).toBe(FetchErrors.Timeout)

    const data = tracer.span('GET')
    expect(data.status.code).toBe('error')
    expect(data.attributes['error.type']).toBe(FetchErrors.Timeout)
  })

  it('a failure escaping the parent is recorded once, at the fetch span', async () => {
    const refused: FetchDef.Impl = () =>
      Promise.reject(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }))

    const { tracer } = await tracedResult(function* () {
      yield* FetchClient.use()

      return yield* span('handler', () => through(refused, () => Fetch.actions.get(`${base}/json`)))
    })

    const client = tracer.span('GET')
    const handler = tracer.span('handler')
    expect(client.status.code).toBe('error')
    expect(handler.status.code).toBe('error')
    expect(client.events.map(event => event.name)).toEqual(['exception'])
    expect(handler.events).toEqual([])

    const exceptions = tracer.exceptions()
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]!.eventName).toBe('http.client.request.exception')
    expect(exceptions[0]!.severityNumber).toBe(17)
  })

  it('a halted request ends the span cancelled: status unset, no error.type', async () => {
    const { tracer, value } = await traced(function* () {
      yield* FetchClient.use()

      return yield* race([
        (function* () {
          yield* Fetch.actions.get(`${base}/slow`)
          return 'fetched'
        })(),
        (function* () {
          yield* sleep(20)
          return 'timer'
        })(),
      ])
    })

    expect(value).toBe('timer')

    const data = tracer.span('GET')
    expect(data.status).toEqual({ code: 'unset' })
    expect(data.attributes['ozaco.cancelled']).toBe(true)
    expect(data.attributes['error.type']).toBeUndefined()
    expect(tracer.exceptions()).toEqual([])
  })
})

describe('span end follows the body', () => {
  it('open until the body is read, ended right after', async () => {
    const { tracer, value } = await traced(function* (live) {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/json`)
      const before = live.spans.length
      yield* sleep(15)
      const body = yield* response.json()
      return { before, after: live.spans.length, body }
    })

    expect(value).toEqual({ before: 0, after: 1, body: { ok: true } })

    const data = tracer.span('GET')
    // the body was read ~15 ms after the headers: the span covers it
    expect(data.end - data.start).toBeGreaterThanOrEqual(10)
  })

  it('no body (204) ⇒ ended as soon as the response arrives', async () => {
    const { value } = await traced(function* (live) {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/empty`)
      return { status: response.status, ended: live.spans.length }
    })

    expect(value).toEqual({ status: 204, ended: 1 })
  })

  it('HEAD ⇒ ended as soon as the response arrives', async () => {
    const { tracer, value } = await traced(function* (live) {
      yield* FetchClient.use()

      yield* Fetch.actions.head(`${base}/json`)
      return live.spans.length
    })

    expect(value).toBe(1)
    expect(tracer.span('HEAD').attributes['http.response.status_code']).toBe(200)
  })

  it('a body never read ⇒ ended when the scope closes, at the headers time, not cancelled', async () => {
    const { tracer, value } = await traced(function* (live) {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/json`)
      yield* sleep(30)
      return { status: response.status, open: live.spans.length }
    })

    expect(value).toEqual({ status: 200, open: 0 })

    const data = tracer.span('GET')
    expect(data.attributes['ozaco.cancelled']).toBeUndefined()
    expect(data.status).toEqual({ code: 'unset' })
    // ended at the headers, not after the 30 ms sleep
    expect(data.end - data.start).toBeLessThan(25)
  })

  it('a parse failure is recorded on the span (error status, one exception there)', async () => {
    const { tracer, result } = await tracedResult(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/garbage`)
      return yield* response.json()
    })

    expect(isFailure(result)).toBe(true)

    const data = tracer.span('GET')
    expect(data.status.code).toBe('error')
    expect(data.attributes['http.response.status_code']).toBe(200)
    expect(data.attributes['error.type']).toBe(ResultErrors.Unknown)
    expect(data.events.map(event => event.name)).toEqual(['exception'])

    const exceptions = tracer.exceptions()
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]!.eventName).toBe('http.client.request.exception')
    expect(exceptions[0]!.context?.spanId).toBe(data.context.spanId)
  })

  it('a whole-body read halted midway ⇒ cancelled, at the halt', async () => {
    const { tracer, value } = await traced(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/drip`)

      return yield* race([
        response.text(),
        (function* () {
          yield* sleep(20)
          return 'timer'
        })(),
      ])
    })

    expect(value).toBe('timer')

    const data = tracer.span('GET')
    expect(data.attributes['ozaco.cancelled']).toBe(true)
    expect(data.status).toEqual({ code: 'unset' })
    expect(tracer.exceptions()).toEqual([])
  })

  it('raw(): ends when the stream is drained', async () => {
    const { tracer, value } = await traced(function* (live) {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/stream`)
      const subscription = yield* yield* response.raw()
      const decoder = new TextDecoder()
      let text = ''
      let open = 0

      for (;;) {
        const step = yield* subscription.next()
        if (step.done) {
          break
        }
        open = live.spans.length
        text += decoder.decode(step.value)
      }

      return { text, open, ended: live.spans.length }
    })

    expect(value).toEqual({ text: 'abc', open: 0, ended: 1 })
    expect(tracer.span('GET').attributes['ozaco.cancelled']).toBeUndefined()
  })

  it('raw(): a stream abandoned before its end ⇒ cancelled when the consumer closes', async () => {
    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/stream`)

      yield* (function* () {
        const subscription = yield* yield* response.raw()
        yield* subscription.next()
      })()
    })

    expect(tracer.span('GET').attributes['ozaco.cancelled']).toBe(true)
    expect(tracer.span('GET').status).toEqual({ code: 'unset' })
  })
})

describe('flow() span end', () => {
  /** A transport answering with each string as its own chunk. */
  const chunked =
    (...chunks: string[]): FetchDef.Impl =>
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(new TextEncoder().encode(chunk))
              }
              controller.close()
            },
          }),
        ),
      )

  it('a decoded stream ends the span when it closes', async () => {
    const { tracer, value } = await traced(function* (live) {
      yield* FetchClient.use()
      yield* JsonCodec.use()

      return yield* through(chunked('{"id":1}', '{"id":2}'), function* () {
        const response = yield* Fetch.actions.get(`${base}/ndjson`)
        const subscription = yield* yield* response.flow()
        const values: unknown[] = []
        let open = -1

        for (;;) {
          const step = yield* subscription.next()
          if (step.done) {
            return { values, open, close: step.value, ended: live.spans.length }
          }
          open = live.spans.length
          values.push(step.value)
        }
      })
    })

    expect(value).toEqual({ values: [{ id: 1 }, { id: 2 }], open: 0, close: true, ended: 1 })
    expect(tracer.span('GET').status).toEqual({ code: 'unset' })
  })

  it('a stream closing with a decode failure fails the span with it', async () => {
    const { tracer, value } = await traced(function* () {
      yield* FetchClient.use()
      yield* JsonCodec.use()

      return yield* through(chunked('{"broken":', 'not-json}}}'), function* () {
        const response = yield* Fetch.actions.get(`${base}/ndjson`)
        const subscription = yield* yield* response.flow()

        for (;;) {
          const step = yield* subscription.next()
          if (step.done) {
            return isFailure(step.value)
          }
        }
      })
    })

    expect(value).toBe(true)

    const data = tracer.span('GET')
    expect(data.status.code).toBe('error')
    expect(data.events.map(event => event.name)).toEqual(['exception'])
    // the fetch span is its own local root: the failure settles as it ends, unclassified ⇒ ERROR
    const [log, ...rest] = tracer.exceptions()
    expect(rest).toEqual([])
    expect(log!.eventName).toBe('http.client.request.exception')
    expect(log!.severityNumber).toBe(17)
  })
})

describe('propagation', () => {
  it('injects the CLIENT span context: traceparent + tracestate ozaco=1', async () => {
    const { tracer, value } = await traced(function* () {
      yield* FetchClient.use()

      const response = yield* Fetch.actions.get(`${base}/headers`)
      return (yield* response.json()) as { traceparent: string; tracestate: string }
    })

    const data = tracer.span('GET')
    expect(value.traceparent).toBe(traceparentOf(data.context))
    expect(value.traceparent.endsWith('-03')).toBe(true)
    expect(value.tracestate).toBe('ozaco=1')
  })

  it('keeps an inherited tracestate behind ozaco=1', async () => {
    const parent = extract(name => (name === 'traceparent' ? INBOUND : 'vendor=abc'))!
    const { seen, impl } = capture()

    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* span('server', { parent }, () =>
        through(impl, () => Fetch.actions.get(`${base}/x`)),
      )
    })

    const data = tracer.span('GET')
    expect(data.context.traceId).toBe(parent.traceId)
    expect(seen.headers!.get('traceparent')).toBe(traceparentOf(data.context))
    expect(seen.headers!.get('tracestate')).toBe('ozaco=1,vendor=abc')
  })

  it('an unsampled parent: the span id goes out with flags 00 and no ozaco=1', async () => {
    const parent = parseTraceparent(INBOUND.replace(/-01$/u, '-00'))!
    const { seen, impl } = capture()

    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* span('server', { parent }, () =>
        through(impl, () => Fetch.actions.get(`${base}/x`)),
      )
    })

    expect(tracer.spans).toEqual([])
    const sent = parseTraceparent(seen.headers!.get('traceparent'))!
    expect(sent.traceId).toBe(parent.traceId)
    expect(sent.spanId).not.toBe(parent.spanId)
    expect(sent.flags & 0x01).toBe(0)
    expect(seen.headers!.get('tracestate')).toBeNull()
  })

  it('a caller-set traceparent wins (its tracestate kept); other headers still merge', async () => {
    const { seen, impl } = capture()

    const { tracer } = await traced(function* () {
      yield* FetchClient.use({ headers: { 'x-default': 'd' } })

      return yield* through(impl, () =>
        Fetch.actions.get(`${base}/x`, {
          headers: { traceparent: INBOUND, tracestate: 'mine=1' },
        }),
      )
    })

    expect(tracer.names()).toBe('GET')
    expect(seen.headers!.get('traceparent')).toBe(INBOUND)
    expect(seen.headers!.get('tracestate')).toBe('mine=1')
    expect(seen.headers!.get('x-default')).toBe('d')
  })

  it('a Request input keeps its own headers next to the injected ones', async () => {
    const { seen, impl } = capture()

    await traced(function* () {
      yield* FetchClient.use()

      return yield* through(impl, () =>
        Fetch.actions.request(new Request(`${base}/x`, { headers: { 'x-own': 'yes' } })),
      )
    })

    expect(seen.headers!.get('x-own')).toBe('yes')
    expect(seen.headers!.get('traceparent')).not.toBeNull()
  })

  it('propagate: false (request or install) sends no trace context; the span still exists', async () => {
    const perRequest = capture()
    const perInstall = capture()

    const { tracer } = await traced(function* () {
      yield* FetchClient.use()
      yield* through(perRequest.impl, () =>
        Fetch.actions.get(`${base}/x`, { propagate: false, headers: { tracestate: 'mine=1' } }),
      )
    })

    const other = await traced(function* () {
      yield* FetchClient.use({ propagate: false })
      yield* through(perInstall.impl, () => Fetch.actions.get(`${base}/x`))
    })

    expect(tracer.names()).toBe('GET')
    expect(other.tracer.names()).toBe('GET')
    expect(perRequest.seen.headers!.get('traceparent')).toBeNull()
    expect(perRequest.seen.headers!.get('tracestate')).toBe('mine=1')
    expect(perInstall.seen.headers!.get('traceparent')).toBeNull()
  })
})

describe('tracing off', () => {
  it('no span; an ambient pass-through context is forwarded unchanged', async () => {
    const inbound = extract(name => (name === 'traceparent' ? INBOUND : 'vendor=abc'))!
    const tracer = memoryTracer()
    const { seen, impl } = capture()

    const outcome = await run(function* () {
      yield* tracer.plugin.use()
      yield* enableTracing(false)
      yield* FetchClient.use()

      return yield* ActiveSpan.with(passThrough(inbound), () =>
        through(impl, function* () {
          const response = yield* Fetch.actions.get(`${base}/x`)
          return yield* response.text()
        }),
      )
    })

    expect(unwrap(outcome)).toBe('ok')
    expect(tracer.spans).toEqual([])
    expect(tracer.logs).toEqual([])
    expect(seen.headers!.get('traceparent')).toBe(INBOUND)
    expect(seen.headers!.get('tracestate')).toBe('vendor=abc')
  })

  it('a stray caller tracestate never pairs with an injected traceparent', async () => {
    const inbound = parseTraceparent(INBOUND)!
    const { seen, impl } = capture()

    const outcome = await run(function* () {
      yield* FetchClient.use()

      return yield* ActiveSpan.with(passThrough(inbound), () =>
        through(impl, () => Fetch.actions.get(`${base}/x`, { headers: { tracestate: 'stray=1' } })),
      )
    })

    expect(isFailure(outcome)).toBe(false)
    expect(seen.headers!.get('traceparent')).toBe(INBOUND)
    expect(seen.headers!.has('tracestate')).toBe(false)
  })

  it('no tracer, no ambient context ⇒ no trace headers at all', async () => {
    const { seen, impl } = capture()

    const outcome = await run(function* () {
      yield* FetchClient.use()
      return yield* through(impl, () => Fetch.actions.get(`${base}/x`))
    })

    expect(isFailure(outcome)).toBe(false)
    expect(seen.headers!.get('traceparent')).toBeNull()
    expect(seen.headers!.has('tracestate')).toBe(false)
  })

  it('suppressed ⇒ no span; the ambient context goes out unsampled', async () => {
    const { seen, impl } = capture()

    const { tracer } = await traced(function* () {
      yield* FetchClient.use()

      return yield* span('outer', () =>
        suppressed(() => through(impl, () => Fetch.actions.get(`${base}/x`))),
      )
    })

    expect(tracer.names()).toBe('outer')
    const sent = parseTraceparent(seen.headers!.get('traceparent'))!
    expect(sent.spanId).toBe(tracer.span('outer').context.spanId)
    // sampled bit clear; the random bit of the trace id minted here stays
    expect(sent.flags).toBe(2)
  })
})
