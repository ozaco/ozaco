/**
 * Tracing (std:trace) against a REAL server (BunEdge on a random port) with an in-memory Tracer:
 * one CLIENT span per call the server continues, W3C propagation (`ozaco=1` while recording, the
 * ambient context as it is while tracing is off), spans that end with streamed replies,
 * failures decoded from the wire (nested failures, the `remote: …` cause, recorded once per
 * trace), the platform faults `ClientErrors` classifies (the platform error kept as `raw`), and
 * realtime frames carrying the context.
 */
import { ClientErrors, createClient, wireFailureOf } from 'client:core'
import type { Flow, Operation } from 'std:effect'
import { attempt, run, scoped, sleep, until } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, ResultErrors, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import {
  ActiveSpan,
  getTracestate,
  isRecorded,
  parseTraceparent,
  passThrough,
  span,
  traceparentOf,
} from 'std:trace'
import type { WsDef } from 'std:ws'
import { Ws, WsErrors } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot } from './fixture'
import type { MemoryTracer } from './tracer'
import { memoryTracer } from './tracer'

function* drain<T>(flow: Flow<T, void>, max = Infinity): Operation<T[]> {
  const out: T[] = []
  const subscription = yield* flow

  while (out.length < max) {
    const step = yield* subscription.next()

    if (step.done) {
      break
    }

    out.push(step.value)
  }

  return out
}

/** Poll `ready` (every 10 ms, up to ~1 s) — spans ended from promise land / a handler's next
 * pull land a moment later. */
function* settled(ready: () => boolean): Operation<void> {
  for (let waited = 0; waited < 100 && !ready(); waited += 1) {
    yield* sleep(10)
  }
}

/** The one CLIENT span named `name` (fails the test when there is not exactly one). */
const only = (tracer: MemoryTracer, name: string): TraceDef.SpanData => {
  const found = tracer.client(name)
  expect(found.map(data => data.name)).toEqual([name])
  return found[0]!
}

const traceparent = (data: TraceDef.SpanData): string => traceparentOf(data.context)

/** The failures `failure` wraps (its nested causes), in order. */
const nestedOf = (failure: Result.Failure<unknown>): Result.Failure<unknown>[] =>
  failure.causes.filter((cause): cause is Result.Failure<unknown> => isFailure(cause))

/** The `remote: …` cause naming where a decoded failure came from. */
const origin = (operation: string, service?: string, spanId?: string): string =>
  `remote: ${operation}${service ? ` @ ${service}` : ''}${spanId ? ` span ${spanId.slice(0, 8)}` : ''}`

/** Run `body` with a fresh in-memory tracer installed at the root (a server booted there
 * observes, a client created there traces). */
const traced = async (body: (tracer: MemoryTracer) => Operation<void>): Promise<void> => {
  const tracer = memoryTracer()

  unwrap(
    await run(function* () {
      yield* tracer.plugin.use()
      yield* body(tracer)
    }),
  )
}

describe('trace — the CLIENT span of a call', () => {
  it('is ONE span `{METHOD} {route}` the server continues; its context rides with ozaco=1', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      const seen = (yield* client.probe.headers()) as Record<string, string>
      const call = only(tracer, 'GET /probe/headers')
      const target = new URL('/probe/headers', url)

      expect(call.kind).toBe('client')
      expect(call.scope.name).toBe('@ozaco/client')
      expect(call.status.code).toBe('unset')
      expect(call.attributes).toMatchObject({
        'http.request.method': 'GET',
        'url.full': target.href,
        'url.template': '/probe/headers',
        'server.address': target.hostname,
        'server.port': Number(target.port),
        'http.response.status_code': 200,
      })
      // `rpc.method` is never added — the route names the call
      expect(call.attributes['rpc.method']).toBeUndefined()

      // THAT span's context went out, marked as an exporting ozaco caller
      expect(seen.traceparent).toBe(traceparent(call))
      expect(getTracestate(seen.tracestate, 'ozaco')).toBe('1')

      // … so the server CONTINUED it: its edge span is the client span's child
      const [edge] = tracer.server('GET /probe/headers')
      expect(edge?.parent?.spanId).toBe(call.context.spanId)
      expect(edge?.context.traceId).toBe(call.context.traceId)

      // the reply's `traceresponse` names the trace
      expect(client.$lastTraceId()).toBe(call.context.traceId)
      const withMeta = yield* client.$callWithMeta('demo.byId', { id: 'm' })
      expect(withMeta.meta.traceId).toBe(only(tracer, 'GET /demo/:id').context.traceId)
    }))

  it('names by the route TEMPLATE; url.full is the real URL with secrets redacted', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      yield* client.demo.byId({ id: 'x1' })
      yield* client.$call('demo.echo', { text: 'a', token: 'secret-value' })

      const byId = only(tracer, 'GET /demo/:id')
      expect(byId.attributes['url.template']).toBe('/demo/:id')
      expect(String(byId.attributes['url.full'])).toEndWith('/demo/x1')

      const echo = only(tracer, 'GET /demo/echo')
      expect(String(echo.attributes['url.full'])).toContain('token=REDACTED')
      expect(String(echo.attributes['url.full'])).not.toContain('secret-value')
    }))

  it('the manifest fetch is a CLIENT span of its own', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })

      yield* client.$manifest()
      yield* client.$manifest()

      // fetched once: one span
      const manifest = only(tracer, 'GET /docs/manifest')
      expect(manifest.kind).toBe('client')
      expect(manifest.attributes['http.response.status_code']).toBe(200)
    }))

  it('nests under the caller span; the caller`s own traceparent header wins', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      const outer = yield* span('outer', function* (handle) {
        yield* client.demo.byId({ id: 'n' })
        return handle.context
      })

      expect(only(tracer, 'GET /demo/:id').parent?.spanId).toBe(outer.spanId)

      const mine = `00-${'12'.repeat(16)}-${'34'.repeat(8)}-01`
      const seen = (yield* client.probe.headers(undefined, {
        headers: { traceparent: mine, tracestate: 'mine=1' },
      })) as Record<string, string>

      expect(seen.traceparent).toBe(mine)
      expect(seen.tracestate).toBe('mine=1')
    }))

  it('an awaited call (promise land) is traced in the client`s scope', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      const reply = (yield* until(
        client.demo.byId({ id: 'awaited' }) as unknown as Promise<Result<unknown>>,
      )) as Result<unknown>

      expect(unwrap(reply)).toEqual({ id: 'awaited' })
      expect(only(tracer, 'GET /demo/:id').kind).toBe('client')
    }))
})

describe('trace — tracing off', () => {
  it('opens no span; the ambient pass-through context rides as it is, none without one', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const bare = (yield* client.probe.headers()) as Record<string, string>
        expect(bare.traceparent).toBeUndefined()
        expect(bare.tracestate).toBeUndefined()
        // nothing traced, nothing echoed
        expect(client.$lastTraceId()).toBeNull()

        const ambient: TraceDef.SpanContext = {
          traceId: 'ab'.repeat(16),
          spanId: 'cd'.repeat(8),
          flags: 1,
          state: 'vendor=x',
          remote: true,
        }
        const seen = (yield* ActiveSpan.with(passThrough(ambient), () =>
          client.probe.headers(),
        )) as Record<string, string>

        // unchanged — no `ozaco=1`: this caller exports nothing
        expect(seen.traceparent).toBe(traceparentOf(ambient))
        expect(seen.tracestate).toBe('vendor=x')
      }),
    )
  })
})

describe('trace — streamed replies end the span with the stream', () => {
  it('ndjson: drained ⇒ ended; abandoned ⇒ cancelled; bytes read to the end ⇒ ended', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      const flow = yield* client.demo.count({ n: 3 })
      // the reply's headers are in, its body is not: the span is still open
      expect(tracer.client('GET /demo/count')).toHaveLength(0)
      expect(yield* drain(flow as Flow<number, void>)).toEqual([0, 1, 2])

      const counted = only(tracer, 'GET /demo/count')
      expect(counted.attributes['ozaco.cancelled']).toBeUndefined()
      expect(counted.status.code).toBe('unset')

      yield* scoped(function* () {
        const endless = yield* client.probe.endless({ id: 'traced' })
        yield* drain(endless as Flow<number, void>, 2)
      })
      expect(only(tracer, 'GET /probe/endless').attributes['ozaco.cancelled']).toBe(true)

      const blob = yield* client.demo.blob({ size: 10 })
      expect(tracer.client('GET /demo/blob')).toHaveLength(0)
      const bytes = yield* until(new Response(blob).arrayBuffer())
      expect(bytes.byteLength).toBe(10)
      yield* settled(() => tracer.client('GET /demo/blob').length > 0)

      const read = only(tracer, 'GET /demo/blob')
      expect(read.attributes['ozaco.cancelled']).toBeUndefined()
      expect(read.status.code).toBe('unset')
    }))

  it('bytes that fail mid-read: the span fails client.network (a classified platform fault)', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const manifest = yield* (yield* createClient<Api>({ url })).$manifest()
      const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      // a reply whose body breaks after its first chunk
      const broken = (() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array([1]))
                controller.error(reset)
              },
            }),
            { headers: { 'oz-brand': 'bytes' } },
          ),
        )) as unknown as typeof fetch
      const client = yield* createClient<Api>({ url, manifest, fetch: broken })

      const blob = yield* client.demo.blob({ size: 10 })
      expect(isFailure(yield* attempt(() => until(new Response(blob).arrayBuffer())))).toBe(true)
      yield* settled(() => tracer.client('GET /demo/blob').length > 0)

      // the read's platform error ends the span through `asFailure(error, ClientErrors)`: a
      // transport fault, so `client.network` (never a `std:result.unknown` fold), named by its
      // code
      const call = only(tracer, 'GET /demo/blob')
      expect(call.status.code).toBe('error')
      expect(call.attributes['error.type']).toBe(ClientErrors.Network)
      const exception = tracer.exceptions().find(log => log.context?.spanId === call.context.spanId)
      expect(exception?.attributes['exception.type']).toBe(ClientErrors.Network)
      expect(exception?.attributes['exception.message']).toBe('ECONNRESET')
    }))
})

describe('trace — failures decoded from the wire', () => {
  it('the server recorded it in the SAME trace: the CLIENT span only fails, ONE exception', () =>
    traced(function* (tracer) {
      // a node that TRUSTS its callers (`trace.trust`): only those get the nested chain back
      const { url } = yield* boot({ trust: true })
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      const failed = (yield* attempt(client.probe.wrapped())) as Result.Failure<unknown>
      expect(isFailure(failed)).toBe(true)

      const call = only(tracer, 'GET /probe/wrapped')
      const [edge] = tracer.server('GET /probe/wrapped')

      // the tag, message and the req/status breadcrumbs LAST
      expect(failed.error).toBe('probe.wrapped')
      expect(failed.message).toBe('outer wrap')
      expect(failed.causes.at(-2)).toStartWith('req:')
      expect(failed.causes.at(-1)).toBe('status:500')

      // a trusted caller gets the nested failure back (through JsonCodec): the platform error's
      // fold — its tag and text, never the platform error itself (`raw` stays on the node)
      const [inner] = nestedOf(failed)
      expect(nestedOf(failed)).toHaveLength(1)
      expect(inner!.error).toBe(ResultErrors.Unknown)
      expect(inner!.message).toContain('inner type error')
      expect('raw' in inner!).toBe(false)
      expect(wireFailureOf(failed).causes[0]).toContain('inner type error')

      // where it was answered (the server's edge span), and that it was recorded there
      expect(failed.causes.at(-3)).toBe(origin('probe.wrapped', 'probe', edge!.context.spanId))
      expect(isRecorded(failed, call.context.traceId)).toBe(true)

      // the CLIENT span fails with the tag; the exception is the server's, once per trace
      expect(call.status.code).toBe('error')
      expect(call.attributes).toMatchObject({
        'error.type': 'probe.wrapped',
        'ozaco.failure.remote': true,
        'http.response.status_code': 500,
      })
      const exceptions = tracer.exceptions()
      expect(exceptions).toHaveLength(1)
      expect(exceptions[0]!.context?.traceId).toBe(call.context.traceId)
      expect(exceptions[0]!.context?.spanId).not.toBe(call.context.spanId)
      expect(exceptions[0]!.scope.name).not.toBe('@ozaco/client')
    }))

  it('a recording caller the node does not trust: the SAME trace, ONE exception, no chain', () =>
    traced(function* (tracer) {
      // `ozaco=1` is self-asserted: the node continues the trace but keeps its causes to itself
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      const failed = (yield* attempt(client.probe.wrapped())) as Result.Failure<unknown>
      const call = only(tracer, 'GET /probe/wrapped')
      const [edge] = tracer.server('GET /probe/wrapped')

      expect(failed.error).toBe('probe.wrapped')
      expect(nestedOf(failed)).toEqual([])
      expect(edge?.parent?.spanId).toBe(call.context.spanId)
      expect(failed.causes.at(-3)).toBe(origin('probe.wrapped', 'probe', edge!.context.spanId))
      expect(isRecorded(failed, call.context.traceId)).toBe(true)
      expect(call.attributes['ozaco.failure.remote']).toBe(true)
      expect(tracer.exceptions()).toHaveLength(1)
      expect(tracer.exceptions()[0]!.scope.name).not.toBe('@ozaco/client')
    }))

  it('a 4xx still fails a CLIENT span (every failure does), error.type = the tag', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      yield* attempt(client.probe.teapot())
      const call = only(tracer, 'GET /probe/teapot')

      expect(call.status.code).toBe('error')
      expect(call.attributes['error.type']).toBe('probe.teapot')
      expect(call.attributes['http.response.status_code']).toBe(418)
      expect(tracer.exceptions()).toHaveLength(1)
    }))

  it('a server that recorded nothing: the CLIENT span records it — once, by status class', async () => {
    const tracer = memoryTracer()

    unwrap(
      await run(function* () {
        // booted BEFORE the tracer, in the outer scope: this node does not observe
        const { url } = yield* boot()

        yield* scoped(function* () {
          yield* tracer.plugin.use()
          const client = yield* createClient<Api>({ url })
          yield* client.$manifest()

          const failed = (yield* attempt(client.probe.caused())) as Result.Failure<unknown>
          const call = only(tracer, 'GET /probe/caused')

          // the node traced nothing (no `traceresponse`, `traceId: ''`): not recorded there —
          // the call's own trace is still what `$lastTraceId` names
          expect(failed.causes).toContain(origin('probe.caused', 'probe'))
          expect(call.attributes['ozaco.failure.remote']).toBeUndefined()
          expect(client.$lastTraceId()).toBe(call.context.traceId)

          const [exception] = tracer.exceptions()
          expect(tracer.exceptions()).toHaveLength(1)
          expect(exception!.eventName).toBe('http.client.request.exception')
          expect(exception!.severityNumber).toBe(17)
          expect(exception!.context?.spanId).toBe(call.context.spanId)
          expect(exception!.attributes['exception.type']).toBe('probe.caused')

          // a 4xx the caller caused: WARN
          yield* attempt(client.probe.teapot())
          const warned = tracer.exceptions().filter(log => log.body.includes('probe.teapot'))
          expect(warned.map(log => log.severityNumber)).toEqual([13])
        })
      }),
    )
  })

  it('an untraced caller is not trusted: no nested chain, the remote marker all the same', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const failed = (yield* attempt(client.probe.wrapped())) as Result.Failure<unknown>

        expect(failed.error).toBe('probe.wrapped')
        expect(nestedOf(failed)).toEqual([])
        expect(failed.causes).toContain(origin('probe.wrapped', 'probe'))
      }),
    )
  })
})

describe('trace — platform faults are classified, the platform error kept as raw', () => {
  it('network failures (a call, the manifest) are ONE level: client.network over its raw', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const manifest = yield* (yield* createClient<Api>({ url })).$manifest()
      const offline = yield* createClient<Api>({ url: 'http://127.0.0.1:1', manifest })

      const failed = (yield* attempt(offline.demo.byId({ id: 'x' }))) as Result.Failure<unknown>

      expect(failed.error).toBe(ClientErrors.Network)
      // the message names the platform error, never `until`'s `std:result.unknown` fold of it
      expect(failed.message.length).toBeGreaterThan(0)
      expect(failed.message).not.toContain('std:result.unknown')
      // ONE level (no nested fold): the platform error is its `raw`, the call named in its causes
      expect(nestedOf(failed)).toEqual([])
      expect(failed.causes).toEqual(['std:effect.until', 'demo.byId'])
      expect(failed.raw).toBeInstanceOf(Error)

      // the CLIENT span failed with it and recorded it (nobody else could): ERROR
      const call = tracer.client('GET /demo/:id').find(data => data.status.code === 'error')
      expect(call?.attributes['error.type']).toBe(ClientErrors.Network)
      const recorded = tracer
        .exceptions()
        .filter(log => log.context?.spanId === call?.context.spanId)
      expect(recorded.map(log => [log.eventName, log.severityNumber])).toEqual([
        ['http.client.request.exception', 17],
      ])

      const lost = yield* createClient<Api>({ url: 'http://127.0.0.1:1' })
      const down = (yield* attempt(lost.$manifest())) as Result.Failure<unknown>

      expect(down.error).toBe(ClientErrors.Network)
      expect(down.message).not.toContain('std:result.unknown')
      expect(down.causes).toEqual(['std:effect.until', 'manifest'])
      expect(down.raw).toBeInstanceOf(Error)
    }))
})

describe('trace — a realtime socket gone for good', () => {
  it('closes the watch with client.closed — the socket`s failure kept as the cause', async () => {
    const gone = fail(WsErrors.ReconnectExhausted, 'no more redials') as Result.Failure<unknown>

    // a socket whose message flow ends at once with a permanent failure
    const connection = {
      native: undefined,
      url: 'ws://mock/notes/_realtime',
      readyState: 3,
      reconnects: 0,
      *send() {},
      messages: {
        *[Symbol.iterator]() {
          return {
            *next() {
              return { done: true as const, value: gone }
            },
          }
        },
      },
      *close() {},
      closed: undefined,
    } as unknown as WsDef.Connection

    const DeadWs = Ws.implement<WsDef.Context, []>({
      name: 'test/dead-ws',
      version: '0.0.0',
      *setup() {
        return { defaults: {} }
      },
    }).build({
      *connect() {
        return connection
      },
    })

    unwrap(
      await run(function* () {
        yield* DeadWs.use()
        const client = yield* createClient({
          url: 'http://127.0.0.1:1',
          realtimePath: '/_realtime',
        })

        yield* scoped(function* () {
          const frames = yield* client.$watch('notes')
          const failed = (yield* attempt(() => frames.next())) as Result.Failure<unknown>

          expect(failed.error).toBe(ClientErrors.Closed)
          // the socket's failure is the ONE cause — the same object, nested
          expect(failed.causes).toHaveLength(1)
          expect(failed.causes[0]).toBe(gone)
        })
      }),
    )
  })
})

const isReconnect = (link: TraceDef.Link): boolean =>
  link.attributes?.['ozaco.link.reason'] === 'ws.reconnect'

describe('trace — realtime frames carry the context', () => {
  it('upgrade headers, the auth frame and every watch frame; a reconnect sends the previous one', async () => {
    const sockets: { socket: WebSocket; options: AnyType; sent: AnyType[] }[] = []
    const Native = (globalThis as AnyType).WebSocket as typeof WebSocket

    class Spy extends Native {
      constructor(target: string | URL, options?: AnyType) {
        super(target, options)
        sockets.push({ socket: this, options, sent: [] })
      }

      override send(data: Parameters<WebSocket['send']>[0]): void {
        sockets.find(entry => entry.socket === this)?.sent.push(JSON.parse(String(data)))
        super.send(data)
      }
    }

    // WsClient reads `globalThis.WebSocket` at connect time: swap in the spy for this run only
    ;(globalThis as AnyType).WebSocket = Spy

    try {
      await traced(function* (tracer) {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url, token: 'tok' })
        yield* client.$manifest()
        yield* client.notes.create({ title: 'seen', done: false })

        yield* span('watcher', function* (handle) {
          const expected = traceparentOf(handle.context)
          const frames = yield* client.$watch<{ title: string }>('notes')
          const sync = yield* frames.next()
          expect((sync.value as AnyType).t).toBe('sync')

          const [first] = sockets
          // the upgrade (where the platform can set headers) …
          expect(first!.options.headers.traceparent).toBe(expected)
          expect(getTracestate(first!.options.headers.tracestate, 'ozaco')).toBe('1')

          // … the auth frame and the watch frame
          const [auth, watch] = first!.sent
          expect(auth).toMatchObject({ t: 'auth', token: 'tok', traceparent: expected })
          expect(getTracestate(auth.tracestate, 'ozaco')).toBe('1')
          expect(watch).toMatchObject({ t: 'watch', traceparent: expected })
          expect(watch.reconnect).toBeUndefined()

          // the server parents the watch frame's span to it
          yield* settled(() => tracer.server('WS /notes/_realtime').length > 0)
          const [frame] = tracer.server('WS /notes/_realtime')
          expect(frame?.parent?.spanId).toBe(handle.context.spanId)

          // a dropped socket redials: the re-sent frames carry the opening context as
          // `reconnect` — and no `traceparent` of their own
          first!.socket.close(4000, 'drop')

          yield* settled(() => (sockets[1]?.sent.length ?? 0) >= 2)

          const resent = sockets[1]!.sent.find(item => item.t === 'watch')
          expect(resent).toMatchObject({ t: 'watch', reconnect: expected })
          expect(resent.traceparent).toBeUndefined()
          expect(resent.tracestate).toBeUndefined()
          expect(parseTraceparent(resent.reconnect)?.spanId).toBe(handle.context.spanId)

          // the server's span of the redial's watch frame is a fresh ROOT that LINKS the
          // opening (`ws.reconnect`) — never a link to its own parent
          yield* settled(() =>
            tracer.server('WS /notes/_realtime').some(data => data.links.some(isReconnect)),
          )
          const redial = tracer
            .server('WS /notes/_realtime')
            .find(data => data.links.some(isReconnect))!
          expect(redial.parent).toBeNull()
          expect(redial.links.find(isReconnect)?.context.spanId).toBe(handle.context.spanId)
          expect(new Set(redial.links.map(entry => entry.context.spanId)).size).toBe(
            redial.links.length,
          )
        })
      })
    } finally {
      ;(globalThis as AnyType).WebSocket = Native
    }
  })
})

describe('trace — a failed watch the server recorded', () => {
  /** A socket answering every watch with an `error` frame naming `recorder(sent)` as the span
   * that recorded it (what a server that observes sends). */
  const failingWs = (recorder: (sent: string) => string) => {
    let pending: ((frame: unknown) => void) | null = null
    const inbox: unknown[] = []

    const connection = {
      native: undefined,
      url: 'ws://mock/notes/_realtime',
      readyState: 1,
      reconnects: 0,
      *send(frame: AnyType) {
        if (frame.t !== 'watch') {
          return
        }
        const reply = {
          t: 'error',
          id: frame.id,
          tag: 'db.validation',
          message: 'invalid filter',
          recorded: recorder(frame.traceparent),
        }
        if (pending) {
          pending(reply)
          pending = null
        } else {
          inbox.push(reply)
        }
      },
      messages: {
        *[Symbol.iterator]() {
          return {
            *next() {
              const value =
                inbox.shift() ??
                (yield* until(
                  new Promise(resolve => {
                    pending = resolve
                  }),
                ))
              return { done: false as const, value }
            },
          }
        },
      },
      *close() {},
      closed: undefined,
    } as unknown as WsDef.Connection

    return Ws.implement<WsDef.Context, []>({
      name: 'test/failing-ws',
      version: '0.0.0',
      *setup() {
        return { defaults: {} }
      },
    }).build({
      *connect() {
        return connection
      },
    })
  }

  const consume = (tracer: MemoryTracer) =>
    function* (): Operation<{ traceId: string; failed: Result.Failure<unknown> }> {
      const client = yield* createClient({ url: 'http://127.0.0.1:1', realtimePath: '/_realtime' })
      let traceId = ''
      const failed = (yield* attempt(() =>
        span('consumer', function* (handle) {
          traceId = handle.context.traceId
          const frames = yield* client.$watch('notes')
          yield* frames.next()
        }),
      )) as Result.Failure<unknown>

      expect(isFailure(failed)).toBe(true)
      expect(tracer.spans.find(data => data.name === 'consumer')?.attributes['error.type']).toBe(
        'db.validation',
      )
      return { traceId, failed }
    }

  it('in the watch`s own trace: the consumer only fails — the exception is the server`s', () =>
    traced(function* (tracer) {
      // the server's watch span: a child in the trace the watch frame was sent in
      yield* failingWs(sent =>
        traceparentOf({ ...parseTraceparent(sent)!, spanId: 'aaaaaaaaaaaaaaaa' }),
      ).use()
      const { failed, traceId } = yield* consume(tracer)()

      expect(failed.causes).toEqual([origin('watch', 'notes', 'aaaaaaaaaaaaaaaa')])
      expect(isRecorded(failed, traceId)).toBe(true)
      expect(
        tracer.spans.find(data => data.name === 'consumer')?.attributes['ozaco.failure.remote'],
      ).toBe(true)
      expect(tracer.exceptions()).toHaveLength(0)
    }))

  it('a REAL server: its watch span records it ONCE, in the consumer`s trace', () =>
    traced(function* (tracer) {
      const { url } = yield* boot()
      const client = yield* createClient<Api>({ url })
      yield* client.$manifest()

      let traceId = ''
      const failed = (yield* attempt(() =>
        span('consumer', function* (handle) {
          traceId = handle.context.traceId
          // a field the resource does not declare: the server refuses the subscribe
          const frames = yield* client.$watch('notes', {
            filter: { op: 'eq', field: 'nope', value: 1 },
          })
          yield* frames.next()
        }),
      )) as Result.Failure<unknown>

      expect(isFailure(failed)).toBe(true)
      expect(isRecorded(failed, traceId)).toBe(true)

      yield* settled(() => tracer.spans.some(data => data.name === 'watch notes'))
      const watch = tracer.spans.find(data => data.name === 'watch notes')!
      expect(watch.context.traceId).toBe(traceId)
      expect(failed.causes).toEqual([origin('watch', 'notes', watch.context.spanId)])
      expect(watch.status.code).toBe('error')

      // the consumer's span only fails; the one exception is the server's, on its watch span
      const own = tracer.spans.find(data => data.name === 'consumer')!
      expect(own.status.code).toBe('error')
      expect(own.attributes['error.type']).toBe(String(failed.error))
      const exceptions = tracer.exceptions()
      expect(exceptions).toHaveLength(1)
      expect(exceptions[0]!.context?.spanId).toBe(watch.context.spanId)
      expect(exceptions[0]!.scope.name).not.toBe('@ozaco/client')
    }))

  it('recorded in another trace (or not at all): the consumer records it itself', () =>
    traced(function* (tracer) {
      yield* failingWs(() => '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01').use()
      const { failed, traceId } = yield* consume(tracer)()

      // still where it came from — but recorded in ANOTHER trace: not a remote exception here
      expect(failed.causes).toEqual([origin('watch', 'notes', 'b7ad6b7169203331')])
      expect(
        tracer.spans.find(data => data.name === 'consumer')?.attributes['ozaco.failure.remote'],
      ).toBeUndefined()
      expect(tracer.exceptions().map(log => log.context?.traceId)).toEqual([traceId])
    }))
})
