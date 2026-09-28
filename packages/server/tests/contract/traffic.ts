// oxlint-disable import/exports-last
/**
 * The contract tests' traffic: ONE node with every sink installed side by side — the
 * `ObservePlugin` store, a memory `ObserveExporter` (the kernel's events, verbatim), the
 * `StdoutExporter` (its lines captured), the `OtlpExporter` (`encoding: 'json'`), a second OTLP
 * destination speaking protobuf and the `OpenObserveExporter` (protobuf; all three on a fake fetch
 * keeping every POSTed body) — driven through
 * every record shape the kernel makes: a successful action (a `ctx.log` line, a std Logger line,
 * a user span with an event), a nested `ctx.call`, an emit and its handler, a failing action with
 * a three-level cause chain, an unrouted 404, a domain record and a websocket frame.
 */
import type { ObserveDef } from 'server:core'
import {
  action,
  createServer,
  defineEvents,
  Edge,
  HEADERS,
  Observe,
  ObserveExporter,
  Server,
  service,
} from 'server:core'
import { ObservePlugin, StdoutExporter } from 'server:plugins'
import type { Operation } from 'std:effect'
import { run, sleep, until } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { asFailure, fail, unwrap } from 'std:result'
import { Trace } from 'std:trace'

import { BunEdge } from 'server:impl/edge/bun'
import { OpenObserveExporter } from 'server:plugins/observe/openobserve'
import type { OtlpDef } from 'server:plugins/observe/otlp'
import { createOtlpPipeline, OtlpExporter } from 'server:plugins/observe/otlp'
import { z } from 'zod'

import { storage } from '../helpers'

let installs = 0

/** A destination of one's own: every event the kernel fans out, verbatim. */
export const memoryExporter = () => {
  installs += 1

  const seen: ObserveDef.Event[] = []
  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: `test/contract-memory-${installs}`,
    version: '0.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(observed: ObserveDef.Event) {
      seen.push(observed)
    },
    *start() {},
    *flush() {},
  })

  return { plugin, seen }
}

/**
 * A second OTLP destination on the same node, speaking protobuf. `OtlpExporter` installs ONCE per
 * node (a plugin install is keyed by its `name@version`: a second `OtlpExporter.use(…)` replaces
 * the first), so another OTLP-speaking exporter is built the way `OpenObserveExporter` is — an
 * `ObserveExporter` impl of its own over the public `createOtlpPipeline`.
 */
const secondOtlp = (options: OtlpDef.Options) => {
  installs += 1

  const Impl = ObserveExporter.implement<OtlpDef.Context, []>({
    name: `test/contract-otlp-${installs}`,
    version: '0.0.0',
    *setup() {
      const kernel = yield* Server.context.expect()

      return { exporter: 'otlp', ...(yield* createOtlpPipeline(kernel, options)) }
    },
  })

  return Impl.build({
    *export(observed: ObserveDef.Event) {
      yield* (yield* Impl.context.expect()).handle.export(observed)
    },
    *start() {
      yield* (yield* Impl.context.expect()).handle.start()
    },
    *flush() {
      yield* (yield* Impl.context.expect()).handle.flush()
    },
  })
}

/** One POST a fake collector received. */
export interface Posted {
  readonly url: string
  readonly contentType: string
  readonly body: Uint8Array
}

/** A fake OTLP/HTTP collector: keeps every POST, answers 200 `{}`. */
export const fakeCollector = () => {
  const posted: Posted[] = []
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    const body =
      typeof init?.body === 'string'
        ? new TextEncoder().encode(init.body)
        : new Uint8Array(init?.body as ArrayBufferLike)

    posted.push({
      url: String(url),
      contentType: new Headers(init?.headers).get('content-type') ?? '',
      body,
    })

    return Promise.resolve(new Response('{}', { status: 200 }))
  }) as typeof fetch

  const bodies = (signal: 'traces' | 'logs' | 'metrics'): Uint8Array[] =>
    posted.filter(entry => entry.url.endsWith(`/v1/${signal}`)).map(entry => entry.body)

  const texts = (signal: 'traces' | 'logs' | 'metrics'): string[] =>
    bodies(signal).map(body => new TextDecoder().decode(body))

  return { fetch: fetchImpl, posted, bodies, texts }
}

/** `console.log` captured (split into lines) while `body` runs. */
export const captureStdout = async <T>(
  body: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> => {
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

const orders = defineEvents({
  'shop.ordered': z.object({ id: z.string(), qty: z.number() }),
})

type Item = { id: string; price: number }

const shop = service('shop', {
  item: action.query(
    {
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), price: z.number() }),
      route: { method: 'GET', path: '/shop/items/:id' },
    },
    function* ({ input, ctx }): Operation<Item> {
      yield* ctx.log.info('item looked up', { 'app.item_id': input.id, 'app.ratio': 0.25 })
      yield* Logger.actions.info('std logger line', {
        'app.source': 'logger',
        'app.tags': ['a b', 'c'],
      })
      yield* ctx.span(
        'price lookup',
        function* (span) {
          span.addEvent('app.priced', { 'app.price': 9.5, 'app.count': 3 })
        },
        { attributes: { 'app.cached': false, 'app.ids': [1, 2] } },
      )

      return { id: input.id, price: 9.5 }
    },
  ),
  order: action.mutation(
    {
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), total: z.number() }),
      route: { method: 'POST', path: '/shop/orders' },
    },
    // a nested call of its own service: the return annotation breaks the inference cycle
    function* ({ input, ctx }): Operation<{ id: string; total: number }> {
      const item = yield* ctx.call(shop, 'item', { id: input.id })

      yield* orders.emit('shop.ordered', { id: input.id, qty: 2 })
      yield* Server.actions.report({ stream: 'audit', 'app.verb': 'ordered', 'app.qty': 2 })

      return { id: input.id, total: item.price * 2 }
    },
  ),
  broken: action.query(
    { output: z.string(), route: { method: 'GET', path: '/shop/broken' } },
    function* () {
      // three levels: outer → middle → a thrown TypeError's fold (the error as its `raw`)
      return yield* fail(
        'shop.broken',
        'order broke',
        fail('shop.store', 'store failed', asFailure(new TypeError('disk gone'))),
      )
    },
  ),
})

/** One in-process request, its body read to the end (the edge span ends with it). */
function* request(path: string, init?: RequestInit): Operation<number> {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))

  yield* until(response.text())
  // the span of a streamed body ends from the edge's scope: let that run
  yield* sleep(5)

  return response.status
}

/** Dial a socket, send `frames` once it greets, wait for `replies` answers, then close. */
const converse = (url: string, frames: readonly unknown[], replies: number): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const got: unknown[] = []
    const ws = new WebSocket(url)

    ws.addEventListener('message', message => {
      got.push(JSON.parse(String(message.data)))

      if (got.length === 1) {
        for (const frame of frames) {
          ws.send(JSON.stringify(frame))
        }
      }

      if (got.length === 1 + replies) {
        ws.close()
      }
    })
    ws.addEventListener('close', () => resolve(got))
    ws.addEventListener('error', () => reject(new Error('socket error')))
  })

/** Wait (bounded) until `check()` holds. */
function* settle(check: () => boolean, ms = 3000): Operation<void> {
  const deadline = Date.now() + ms

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the traffic to settle')
    }

    yield* sleep(5)
  }
}

export interface Traffic {
  /** what the kernel handed every sink (the memory exporter). */
  readonly events: readonly ObserveDef.Event[]
  /** the store's view of every trace the kernel reported (`Observe.actions.trace`). */
  readonly store: readonly ObserveDef.TraceView[]
  readonly stdout: readonly string[]
  readonly json: ReturnType<typeof fakeCollector>
  readonly protobuf: ReturnType<typeof fakeCollector>
  readonly openobserve: ReturnType<typeof fakeCollector>
  readonly statuses: Readonly<Record<string, number>>
  readonly replies: readonly unknown[]
}

/** Run the whole traffic once against a node with every sink. */
export const runTraffic = async (): Promise<Traffic> => {
  const memory = memoryExporter()
  const json = fakeCollector()
  const protobuf = fakeCollector()
  const openobserve = fakeCollector()
  const statuses: Record<string, number> = {}
  let replies: unknown[] = []
  let store: ObserveDef.TraceView[] = []

  const { lines } = await captureStdout(async () =>
    unwrap(
      await run(function* () {
        yield* storage()
        // a std Logger at the root: the node bridges its lines (TraceTransport) into every sink
        yield* DefaultLogger.use({ level: LogLevel.info })

        const server = yield* createServer({
          services: [shop],
          name: 'contract',
          edge: BunEdge,
          observe: { capture: { headers: true, bodies: true, frames: true } },
          plugins: [
            ObservePlugin.use({ batch: { waitMs: 5 } }),
            memory.plugin,
            StdoutExporter,
            OtlpExporter.use({
              url: 'http://collector:4318',
              encoding: 'json',
              fetch: json.fetch,
              batch: { size: 5, waitMs: 5 },
              metrics: { intervalMs: 60_000 },
            }),
            secondOtlp({
              url: 'http://collector-pb:4318',
              encoding: 'protobuf',
              fetch: protobuf.fetch,
              batch: { size: 7, waitMs: 5 },
              metrics: false,
            }),
            OpenObserveExporter.use({
              url: 'http://openobserve:5080',
              auth: { user: 'root@ozaco.dev', pass: 'Ozaco-pass1!' },
              fetch: openobserve.fetch,
              batch: { size: 3, waitMs: 5 },
              metrics: false,
            }),
          ],
        })

        yield* orders.handle('shop.ordered', function* (payload) {
          yield* Trace.actions.event('app.shipped', { 'app.qty': payload.qty })
        })

        yield* Edge.actions.socket({
          path: '/shop/live/:room',
          receives: z.object({ t: z.string(), text: z.string() }),
          *handler(socket) {
            yield* socket.send({ t: 'hello' })

            const messages = yield* socket.messages

            for (;;) {
              const step = yield* messages.next()

              if (step.done) {
                return
              }

              const { text } = step.value as { text: string }

              yield* socket.ctx.log.info('heard', { 'app.text': text })
              yield* socket.send({ t: 'echo', text })
            }
          },
        })

        const info = yield* server.start({ port: 0 })

        statuses['item'] = yield* request('/shop/items/a1?token=secret&page=2', {
          headers: {
            'user-agent': 'contract/1.0',
            authorization: 'Bearer secret-token',
            [HEADERS.requestId]: 'req-contract',
          },
        })
        statuses['order'] = yield* request('/shop/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'b2' }),
        })
        statuses['broken'] = yield* request('/shop/broken')
        statuses['missing'] = yield* request('/nowhere')
        replies = yield* until(
          converse(
            `${info.url!.replace('http', 'ws')}/shop/live/lobby`,
            [{ t: 'say', text: 'hi there' }],
            1,
          ),
        )

        // everything asynchronous has landed: the handler's event, the socket's close line
        yield* settle(() =>
          memory.seen.some(seen => seen.t === 'log' && seen.log.body === 'socket closed'),
        )
        yield* settle(() =>
          memory.seen.some(seen => seen.t === 'span' && seen.span.name === 'process shop.ordered'),
        )
        yield* server.stop()

        // the store answers after the stop too: every trace any record belongs to
        const traceIds = new Set(
          memory.seen.flatMap(seen =>
            seen.t === 'span'
              ? [seen.span.context.traceId]
              : seen.log.context
                ? [seen.log.context.traceId]
                : [],
          ),
        )
        const views: ObserveDef.TraceView[] = []

        for (const traceId of traceIds) {
          const view = yield* Observe.actions.trace(traceId)

          if (view) {
            views.push(view)
          }
        }

        store = views
      }),
    ),
  )

  return {
    events: memory.seen,
    store,
    stdout: lines,
    json,
    protobuf,
    openobserve,
    statuses,
    replies,
  }
}
