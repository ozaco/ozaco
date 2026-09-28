// oxlint-disable import/exports-last
/**
 * The observe docker leg's workload (design §11): TWO in-process nodes of one app over the
 * NetworkCarrier + MemoryTransport, both exporting to the REAL backends with `OtlpExporter`
 * (protobuf → otel-lgtm's collector) AND `OpenObserveExporter` side by side:
 *
 * - `a` — the edge: BunEdge, StaticAuth + Auth, Resilience, a websocket route, the consumer of
 *   `note.stored`; hosts `api-<run>`, which reaches `store-<run>` over the carrier.
 * - `b` — the owner: sqlite (client db spans with `db.namespace`), the `jobs` queue and its
 *   worker, a std Logger line per stored note; hosts `store-<run>`.
 *
 * It drives every request the assertions read back, waits for the event consumer and the queue
 * worker, STOPS both nodes (the exporters flush) and hands over the ids. Service names carry a
 * per-run suffix so runs never read each other's data. Memoized: the test files of one
 * `bun test` process share ONE run (a file run alone runs it itself).
 */
import { column, DbClient, defineSchema, table, useDb } from 'db:core'
import { Queue, queueTable } from 'db:queue'
import { action, createServer, defineEvents, Edge, service } from 'server:core'
import type { ServerDef } from 'server:core'
import { Auth, Resilience, StaticAuth } from 'server:plugins'
import { createQueue, fork, run, scoped, sleep, until } from 'std:effect'
import type { Operation } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryKv } from 'db:impl/memory-kv'
import { SqliteAdapter } from 'db:impl/sqlite'
import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { OpenObserveExporter } from 'server:plugins/observe/openobserve'
import type { OtlpDef } from 'server:plugins/observe/otlp'
import { OtlpExporter } from 'server:plugins/observe/otlp'
import { BunIO } from 'std:io/impl/bun'
import { createLink, MemoryTransport } from 'transport:impl/memory'
import { z } from 'zod'

import { storage } from '../helpers'

import { backends, openobserveAuth } from './helpers'

/** The per-run suffix every name carries. */
export const RUN = Math.random().toString(36).slice(2, 8)

/** The application: node name, `service.namespace`, the edge spans' `service.name`. */
export const APP = `ozobs-${RUN}`
export const VERSION = '0.0.1'

/** The gap between websocket frames — every frame span is far shorter, the session longer. */
export const FRAME_GAP_MS = 400

/** The id an unexported client sends in its `traceparent` (and never exports). */
export const INBOUND = { traceId: '00f1c0ffee0000000000000000abcdef', spanId: 'b7ad6b7169203331' }

export const API = `api-${RUN}`
export const STORE = `store-${RUN}`
export const LIVE = `/live-${RUN}/:room`

/** The sqlite file of node `b` — its basename is the db spans' `db.namespace`. */
export const SQLITE = `observe-${RUN}.sqlite`

export interface SpanRef {
  readonly traceId: string
  readonly spanId: string
}

export interface NodeStats {
  readonly otlp: OtlpDef.Stats
  readonly openobserve: OtlpDef.Stats | null
}

export interface Scenario {
  /** epoch ms before the first request — the lower bound of every backend query. */
  readonly startedAt: number
  readonly endedAt: number

  /** the trace id each HTTP request answered (`traceresponse`). */
  readonly traces: {
    readonly chain: string
    /** a handler that THROWS a raw Error — `asFailure`'s fold, answered as `server.internal`. */
    readonly crash: string
    readonly denied: string
    readonly retry: string
    readonly note: string
    readonly inbound: string
  }
  readonly statuses: Readonly<Record<keyof Scenario['traces'], number>>

  /** the websocket session: its frames (as the handler saw them) and how long it lived. */
  readonly socket: {
    readonly frames: readonly SpanRef[]
    readonly replies: readonly unknown[]
    readonly lifetimeMs: number
  }

  /** the `note.stored` consumer span (node a) and the queue attempt span (node b). */
  readonly consumer: SpanRef
  readonly job: SpanRef & { readonly id: string }
  readonly stats: { readonly a: NodeStats; readonly b: NodeStats }
}

const events = defineEvents({
  'note.stored': z.object({ id: z.string(), size: z.number() }),
})

const notes = table('notes', { text: column.text() })
const storeSchema = defineSchema({ notes, jobs: queueTable('jobs') })

/** The innermost level of the chain: a real THROW (folded by `asFailure`, the error its `raw`). */
const readSector = (id: string): void => {
  throw new TypeError(`sector ${id} is unreadable`)
}

/** A raw THROW straight out of a handler (no `fail`): the kernel folds it with `asFailure`. */
const burnDisk = (id: string): never => {
  throw new RangeError(`disk ${id} is on fire`)
}

const thrownBy = (body: () => void): Result.Failure<unknown> | null => {
  try {
    body()

    return null
  } catch (error) {
    return asFailure(error)
  }
}

/** Node b's service: `save` fails with a 3-level chain, `crash` throws a raw Error, `put` writes,
 * logs, emits, enqueues. */
const store = service(STORE, {
  save: action.mutation({ input: z.object({ id: z.string() }) }, function* ({ input }) {
    const thrown = thrownBy(() => readSector(input.id))

    return yield* fail(
      'store.save',
      'the note could not be saved',
      fail('store.write', `writing sector ${input.id} failed`, thrown),
    )
  }),
  crash: action.mutation({ input: z.object({ id: z.string() }) }, function* ({ input }) {
    return burnDisk(input.id)
  }),
  put: action.mutation(
    {
      input: z.object({ text: z.string() }),
      output: z.object({ id: z.string(), job: z.string() }),
    },
    function* ({ input }) {
      yield* Logger.actions.info('note stored', { 'note.size': input.text.length })

      const db = yield* useDb(storeSchema)
      const row = yield* db.insert('notes', { text: input.text })

      yield* events.emit('note.stored', { id: row._id, size: input.text.length })

      const { job } = yield* Queue.actions.enqueue('index', { note: row._id })

      return { id: row._id, job: job._id }
    },
  ),
})

let flakyCalls = 0

/** Node a's service: the edge's entry points. */
const api = service(API, {
  save: action.mutation({ input: z.object({ id: z.string() }) }, function* ({ input, ctx }) {
    return yield* ctx.call(store, 'save', input)
  }),
  crash: action.mutation({ input: z.object({ id: z.string() }) }, function* ({ input, ctx }) {
    return yield* ctx.call(store, 'crash', input)
  }),
  note: action.mutation(
    {
      input: z.object({ text: z.string() }),
      output: z.object({ id: z.string(), job: z.string() }),
    },
    function* ({ input, ctx }) {
      return yield* ctx.call(store, 'put', input)
    },
  ),
  me: action.query({ output: z.string(), auth: 'user' }, function* () {
    return 'me'
  }),
  flaky: action.query(
    { output: z.number(), retry: { times: 2, when: ['api.flaky'], delayMs: 1 } },
    function* () {
      flakyCalls += 1

      if (flakyCalls === 1) {
        return yield* fail('api.flaky', 'the first attempt fails')
      }

      return flakyCalls
    },
  ),
  ping: action.query({ output: z.string() }, function* () {
    return 'pong'
  }),
})

/** Both exporters of a node, transport options only (OpenObserve when its url is set). */
const exporters = () => [
  OtlpExporter.use({
    url: backends.otlp ?? '',
    batch: { waitMs: 100 },
    metrics: { intervalMs: 1000 },
  }),
  ...(backends.openobserve
    ? [
        OpenObserveExporter.use({
          url: backends.openobserve,
          org: openobserveAuth.org,
          auth: { user: openobserveAuth.user, pass: openobserveAuth.pass },
          batch: { waitMs: 100 },
          metrics: { intervalMs: 1000 },
        }),
      ]
    : []),
]

function* statsOf(): Operation<NodeStats> {
  const otlp = (yield* OtlpExporter.context.expect()).stats()
  const openobserve = backends.openobserve
    ? (yield* OpenObserveExporter.context.expect()).stats()
    : null

  return { otlp, openobserve }
}

const traceOf = (response: Response): string => {
  const header = response.headers.get('traceresponse') ?? ''
  const traceId = header.split('-')[1] ?? ''

  if (!/^[0-9a-f]{32}$/u.test(traceId)) {
    throw new Error(`no traceresponse on ${response.url}: ${JSON.stringify(header)}`)
  }

  return traceId
}

/** Dial the socket, say each text FRAME_GAP_MS apart (each after the previous echo), close. */
const converse = (url: string, texts: readonly string[]): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const got: unknown[] = []
    const ws = new WebSocket(url)
    let next = 0

    const later = () => {
      setTimeout(() => {
        const text = texts[next]

        next += 1

        if (text === undefined) {
          ws.close()
        } else {
          ws.send(JSON.stringify({ t: 'say', text }))
        }
      }, FRAME_GAP_MS)
    }

    ws.addEventListener('open', later)
    ws.addEventListener('message', event => {
      got.push(JSON.parse(String(event.data)))
      later()
    })
    ws.addEventListener('close', () => resolve(got))
    ws.addEventListener('error', () => reject(new Error(`socket ${url} failed`)))
  })

/** Wait (≤ 10 s) until `ready()` holds, running `probe` before each look. */
function* settle(
  ready: () => boolean,
  what: string,
  probe?: () => Operation<void>,
): Operation<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (probe) {
      yield* probe()
    }

    if (ready()) {
      return
    }

    yield* sleep(50)
  }

  throw new Error(`timed out waiting for ${what}`)
}

const JSON_HEADERS = { 'content-type': 'application/json' }

const randomHex = (bytes: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex')

/** Node a's ids: every OTHER trace it mints starts with `00` — Tempo's search drops leading zero
 * nibbles, so the readers must pad them back (design §11); span ids stay random. */
const zeroLed = (): TraceDef.Ids => {
  let minted = 0

  return {
    trace: () => {
      minted += 1

      return minted % 2 === 1 ? `00${randomHex(15)}` : randomHex(16)
    },
    span: () => randomHex(8),
  }
}

type NodeA = Omit<Scenario, 'stats'> & { readonly a: NodeStats }

async function drive(): Promise<Scenario> {
  const dir = mkdtempSync(join(tmpdir(), 'ozaco-observe-'))
  const link = createLink()
  const frames: SpanRef[] = []
  const consumed: SpanRef[] = []
  const worked: (SpanRef & { id: string })[] = []

  try {
    return unwrap(
      await run(function* () {
        const bReady = createQueue<void, void>()
        const bStop = createQueue<void, void>()
        const bStopped = createQueue<NodeStats, void>()

        // node b — the owner: sqlite, the queue + its worker
        const nodeB = yield* fork(() =>
          scoped(function* () {
            yield* SqliteAdapter.use({ path: join(dir, SQLITE) })
            yield* BunIO.use()
            yield* DbClient.use({ schema: storeSchema })
            yield* MemoryKv.use()
            yield* MemoryTransport.use({ prefix: APP, link })
            yield* DefaultLogger.use({ level: LogLevel.info })
            yield* Queue.use({ table: 'jobs' })

            const server = yield* createServer({
              name: APP,
              version: VERSION,
              instance: 'b',
              services: [store],
              carrier: NetworkCarrier,
              observe: { environment: 'docker-leg' },
              plugins: exporters(),
            })

            yield* Queue.actions.work(
              {
                *index(job) {
                  const { context } = yield* Trace.actions.current()

                  worked.push({ traceId: context.traceId, spanId: context.spanId, id: job.id })
                },
              },
              { pollMs: 100 },
            )
            bReady.add(undefined)
            yield* bStop.next()
            yield* server.stop()
            bStopped.add(yield* statsOf())
          }),
        )

        yield* bReady.next()

        // node a — the edge: drives every request, then stops (its exporters flush)
        const a = yield* scoped(function* (): Operation<NodeA> {
          yield* storage()
          yield* MemoryTransport.use({ prefix: APP, link })
          yield* DefaultLogger.use({ level: LogLevel.info })
          yield* Trace.actions.useIds(zeroLed())

          const server: ServerDef.Handle<AnyType> = yield* createServer({
            name: APP,
            version: VERSION,
            instance: 'a',
            services: [api],
            edge: BunEdge,
            carrier: NetworkCarrier,
            observe: { environment: 'docker-leg' },
            timeoutMs: 10_000,
            plugins: [
              ...exporters(),
              StaticAuth.use({ tokens: { 'tok-user': { sub: 'user' } } }),
              Auth,
              Resilience,
            ],
          })

          yield* Edge.actions.socket({
            path: LIVE,
            receives: z.object({ text: z.string() }),
            *handler(socket) {
              const messages = yield* socket.messages

              for (;;) {
                const step = yield* messages.next()

                if (step.done) {
                  return
                }

                frames.push({ traceId: socket.ctx.trace.traceId, spanId: socket.ctx.trace.spanId })
                yield* socket.send({ t: 'echo', text: (step.value as { text: string }).text })
              }
            },
          })

          const info = yield* server.start({ port: 0 })
          const base = info.url!

          yield* events.handle('note.stored', function* () {
            const { context } = yield* Trace.actions.current()

            consumed.push({ traceId: context.traceId, spanId: context.spanId })
          })

          // a learns b's store (presence) before the first call
          let members = 0

          yield* settle(
            () => members > 0,
            `a member of ${STORE}`,
            function* () {
              members = (yield* server.members(STORE)).length
            },
          )

          const startedAt = Date.now()
          const request = function* (path: string, init?: RequestInit) {
            const response = yield* until(fetch(`${base}${path}`, init))

            yield* until(response.text())

            return { status: response.status, traceId: traceOf(response) }
          }
          const post = (body: unknown): RequestInit => ({
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(body),
          })

          const chain = yield* request(`/${API}/save`, post({ id: '7' }))
          const crash = yield* request(`/${API}/crash`, post({ id: '9' }))
          const denied = yield* request(`/${API}/me`)
          const retry = yield* request(`/${API}/flaky`)
          const note = yield* request(`/${API}/note`, post({ text: 'hello observability' }))
          // an unexported client's context, NOT sampled — linked, never continued
          const inbound = yield* request(`/${API}/ping`, {
            headers: { traceparent: `00-${INBOUND.traceId}-${INBOUND.spanId}-00` },
          })

          const opened = Date.now()
          const replies = yield* until(
            converse(`${base.replace(/^http/u, 'ws')}/live-${RUN}/lobby`, ['a', 'b']),
          )
          const lifetimeMs = Date.now() - opened

          yield* settle(
            () => consumed.length > 0 && worked.length > 0,
            'the note.stored consumer and the queue worker',
          )
          // their spans end right after the handlers return
          yield* sleep(300)
          yield* server.stop()

          return {
            startedAt,
            endedAt: Date.now(),
            traces: {
              chain: chain.traceId,
              crash: crash.traceId,
              denied: denied.traceId,
              retry: retry.traceId,
              note: note.traceId,
              inbound: inbound.traceId,
            },
            statuses: {
              chain: chain.status,
              crash: crash.status,
              denied: denied.status,
              retry: retry.status,
              note: note.status,
              inbound: inbound.status,
            },
            socket: { frames: [...frames], replies, lifetimeMs },
            consumer: consumed[0]!,
            job: worked[0]!,
            a: yield* statsOf(),
          }
        })

        bStop.add(undefined)

        const b = yield* bStopped.next()

        yield* nodeB

        const { a: aStats, ...rest } = a

        return { ...rest, stats: { a: aStats, b: b.value as NodeStats } }
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let memo: Promise<Scenario> | null = null

/** The ONE run of the workload (memoized per process). */
export const scenario = (): Promise<Scenario> => {
  memo ??= drive()

  return memo
}
