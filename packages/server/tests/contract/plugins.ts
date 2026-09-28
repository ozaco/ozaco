/**
 * Plugin traffic for the key lint: every server plugin that writes telemetry — Auth (granted,
 * anonymous, denied, a skipped strategy, `enduser.id`), CORS (an allowed request, a preflight, a
 * refused origin), Cache (a miss, a hit, an eviction, a failed change-feed invalidation),
 * Resilience (timeout, retry, fallback, breaker, bulkhead, singleflight, rate limit), crud (built-in
 * ops with hooks, a runnable op, a realtime watch whose push fails) and HotReload (two
 * generations) — each on a node of its own, observed by a memory `ObserveExporter` — plus two
 * nodes on a network carrier (rpc client/server spans, a remote failure) with a db queue (an
 * enqueue, a job, a dead-lettered one).
 */
import { DbClient, defineSchema, Kv, useDb } from 'db:core'
import { Queue, queueTable } from 'db:queue'
import type { ObserveDef, ServerDef, ServiceDef } from 'server:core'
import { action, createServer, Edge, refs, service, ServerErrors } from 'server:core'
import type { AuthDef } from 'server:plugins'
import {
  Auth,
  AuthStrategy,
  Cache,
  Cors,
  crud,
  HotReload,
  Resilience,
  StaticAuth,
} from 'server:plugins'
import type { Operation } from 'std:effect'
import { all, attempt, createQueue, fork, run, scoped, sleep, until } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { asFailure, fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'
import { createLink, MemoryTransport } from 'transport:impl/memory'
import { z } from 'zod'

import { storage, testSchema, todosTable } from '../helpers'

import { memoryExporter } from './traffic'

/** One in-process request, its body read to the end. */
function* request(path: string, init?: RequestInit): Operation<number> {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))

  yield* until(response.arrayBuffer())
  yield* sleep(5)

  return response.status
}

/** Boot a node with `options` + a memory exporter (listening when it has an edge), run `body`,
 * stop it: every event the node observed. */
const observe = async (
  options: ServerDef.Options,
  body: (server: ServerDef.Handle<AnyType>, url: string) => Operation<void>,
  before?: () => Operation<void>,
): Promise<ObserveDef.Event[]> => {
  const memory = memoryExporter()

  unwrap(
    await run(function* () {
      yield* storage()
      yield* DefaultLogger.use({ level: LogLevel.info })

      if (before) {
        yield* before()
      }

      const server = yield* createServer({
        ...options,
        plugins: [memory.plugin, ...(options.plugins ?? [])],
      })
      const info = yield* server.start({ port: 0 })

      yield* body(server, info.url ?? '')
      yield* sleep(30)
      yield* server.stop()
    }),
  )

  return memory.seen
}

// --- Auth -----------------------------------------------------------------------------------------

const guarded = service('guarded', {
  me: action.query({ output: z.string(), auth: 'user' }, function* ({ ctx }) {
    return (ctx.auth as AuthDef.Principal).sub
  }),
  admin: action.query({ output: z.string(), auth: ['admin'] }, function* () {
    return 'secret'
  }),
  open: action.query({ output: z.string() }, function* () {
    return 'anyone'
  }),
})

/** A directory that is down for `tok-ui`: a failed strategy before StaticAuth answers. */
const Flaky = AuthStrategy.implement<AuthDef.StrategyContext, []>({
  name: 'test-contract-flaky',
  version: '0.0.0',
  description: 'a directory that is down for tok-ui',
  *setup() {
    return { strategy: 'flaky' }
  },
}).build({
  *verify(token: string) {
    return token === 'tok-ui'
      ? yield* fail(ServerErrors.Unavailable, 'the directory is down')
      : undefined
  },
  *login() {
    return undefined
  },
  *refresh() {
    return undefined
  },
  *signService() {
    return undefined
  },
})

const bearer = (token: string) => ({ meta: { authorization: `Bearer ${token}` } })

const authTraffic = () =>
  observe(
    {
      services: [guarded],
      edge: BunEdge,
      observe: { capture: { enduser: true, headers: true } },
      plugins: [
        Flaky.use(),
        StaticAuth.use({
          tokens: {
            'tok-ui': { sub: 'ui', roles: ['admin'] },
            'tok-guest': { sub: 'guest' },
          },
        }),
        Auth,
      ],
    },
    function* (server) {
      yield* server.call(guarded, 'me', undefined, bearer('tok-ui'))
      yield* server.call(guarded, 'open')
      yield* attempt(server.call(guarded, 'me'))
      yield* attempt(server.call(guarded, 'admin', undefined, bearer('tok-guest')))
      yield* request('/guarded/me', { headers: { authorization: 'Bearer tok-ui' } })
      yield* request('/guarded/admin', { headers: { authorization: 'Bearer nope' } })
    },
  )

// --- CORS -----------------------------------------------------------------------------------------

const APP = 'https://app.test'

const plain = service('plain', {
  open: action.query({ output: z.string() }, function* () {
    return 'anyone'
  }),
})

const corsTraffic = () =>
  observe(
    { services: [plain], edge: BunEdge, plugins: [Cors.use({ origins: [APP] })] },
    function* () {
      yield* request('/plain/open', { headers: { origin: APP } })
      yield* request('/plain/open', { headers: { origin: 'https://evil.test' } })
      yield* request('/plain/open', {
        method: 'OPTIONS',
        headers: {
          origin: APP,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-secret',
        },
      })
    },
  )

// --- Cache ----------------------------------------------------------------------------------------

const cached = service('cached', {
  get: action.query(
    {
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      cache: { ttlMs: 10_000, tags: ['todos'] },
    },
    function* ({ input }) {
      if (input.id === 'bad') {
        return yield* fail('cached.broken', 'cannot compute')
      }

      return { id: input.id }
    },
  ),
  bump: action.mutation({ invalidate: ['todos'] }, function* () {}),
  write: action.mutation({ input: z.object({ title: z.string() }) }, function* ({ input }) {
    const db = yield* useDb(testSchema)

    yield* db.insert('todos', { title: input.title, done: false })
  }),
})

const cacheTraffic = () => {
  const broken = { on: false }

  return observe(
    { services: [cached], plugins: [Cache] },
    function* (server) {
      yield* server.call(cached, 'get', { id: 'a' })
      yield* server.call(cached, 'get', { id: 'a' })
      yield* all([
        attempt(server.call(cached, 'get', { id: 'bad' })),
        attempt(server.call(cached, 'get', { id: 'bad' })),
      ])
      yield* server.call(cached, 'bump')
      broken.on = true
      yield* server.call(cached, 'write', { title: 'x' })
      yield* attempt(server.call(cached, 'bump'))
      yield* sleep(30)
    },
    function* () {
      // the kv store goes down for invalidations: a failed eviction and change-feed root
      yield* Kv.around({
        *invalidate(args, next) {
          if (broken.on) {
            return yield* fail('test.kv-down', 'the kv store is down')
          }

          return yield* next(...args)
        },
      })
    },
  )
}

// --- Resilience -----------------------------------------------------------------------------------

const resilienceTraffic = () => {
  const counters = { flaky: 0 }
  const tough = service('tough', {
    slow: action.query(
      { input: z.object({ ms: z.number() }), output: z.string(), timeoutMs: 40 },
      function* ({ input }) {
        yield* sleep(input.ms)

        return 'done'
      },
    ),
    flaky: action.query(
      { output: z.number(), retry: { times: 2, when: ['tough.down'], delayMs: 1 } },
      function* () {
        counters.flaky += 1

        if (counters.flaky < 3) {
          return yield* fail('tough.down', 'not yet')
        }

        return counters.flaky
      },
    ),
    layered: action.query(
      {
        output: z.string(),
        *fallback() {
          return 'fallback'
        },
      },
      function* () {
        return yield* fail(
          'tough.nope',
          'primary failed',
          asFailure(new TypeError('socket hang up')),
        )
      },
    ),
    trips: action.query(
      { output: z.string(), breaker: { failures: 1, halfOpenMs: 20 } },
      function* () {
        return yield* fail('tough.broken', 'always')
      },
    ),
    narrow: action.query(
      { input: z.object({ ms: z.number() }), output: z.string(), bulkhead: { max: 1, queue: 2 } },
      function* ({ input }) {
        yield* sleep(input.ms)

        return 'ok'
      },
    ),
    shared: action.query(
      { input: z.object({ k: z.string() }), output: z.number(), singleflight: true },
      function* () {
        yield* sleep(20)

        return 1
      },
    ),
    limited: action.query(
      { output: z.string(), rateLimit: { limit: 1, windowMs: 60_000 } },
      function* () {
        return 'ok'
      },
    ),
  })

  return observe({ services: [tough], plugins: [Resilience] }, function* (server) {
    yield* server.call(tough, 'slow', { ms: 1 })
    yield* attempt(server.call(tough, 'slow', { ms: 200 }))
    yield* server.call(tough, 'flaky')
    yield* server.call(tough, 'layered')
    yield* attempt(server.call(tough, 'trips'))
    yield* attempt(server.call(tough, 'trips'))
    yield* sleep(30)
    yield* attempt(server.call(tough, 'trips'))
    yield* all([server.call(tough, 'narrow', { ms: 20 }), server.call(tough, 'narrow', { ms: 20 })])
    yield* all([server.call(tough, 'shared', { k: 'a' }), server.call(tough, 'shared', { k: 'a' })])
    yield* server.call(tough, 'limited')
    yield* attempt(server.call(tough, 'limited'))
  })
}

// --- crud -----------------------------------------------------------------------------------------

const crudTraffic = () => {
  const todos = crud(todosTable, {
    *before({ op, input }) {
      if (op === 'create') {
        return { ...(input as AnyType), title: `${(input as AnyType).title}!` }
      }
    },
    *after({ op, output }) {
      const frame = output as AnyType

      if (op === 'watch' && frame.t === 'delta') {
        return yield* fail('todos.exploded', 'the delta exploded')
      }
    },
    *error({ op, input }) {
      if (op === 'get') {
        const now = new Date().toISOString()

        return {
          _id: String((input as AnyType).id),
          _created_at: now,
          _updated_at: now,
          _version: 'ghost',
          title: 'ghost',
          done: false,
          note: null,
        }
      }
    },
    extend: {
      open: action.query(
        { output: crud.schemas.page(todosTable), route: { method: 'GET', path: '/todos/open' } },
        function* () {
          return yield* crud.list(todosTable)
        },
      ),
    },
  })

  return observe({ services: [todos], edge: BunEdge }, function* (server, url) {
    const post = (title: string) =>
      request('/todos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, done: false }),
      })

    yield* post('first')
    yield* request('/todos')
    yield* request('/todos/open')
    yield* request('/todos/nope')

    // realtime: a watch, then a push that fails
    const frames: AnyType[] = []
    const ws = new WebSocket(`${url.replace('http', 'ws')}/todos/_realtime`)

    ws.addEventListener('message', message => frames.push(JSON.parse(String(message.data))))
    yield* until(
      new Promise<void>(resolve => {
        ws.addEventListener('open', () => resolve())
      }),
    )
    ws.send(JSON.stringify({ t: 'watch', id: 'w1' }))

    for (let at = 0; at < 200 && frames.length === 0; at += 1) {
      yield* sleep(5)
    }

    yield* server.call(todos, 'create', { title: 'second', done: false })

    for (let at = 0; at < 200 && frames.length < 2; at += 1) {
      yield* sleep(5)
    }

    ws.close()
  })
}

// --- HotReload ------------------------------------------------------------------------------------

type Hot = ServiceDef.Service<'hot', { greet: ServiceDef.Action<undefined, z.ZodString> }>

const hotTraffic = () => {
  let greeting = 'one'
  const hot = (text: string) =>
    service('hot', {
      greet: action.query({ output: z.string() }, function* () {
        return text
      }),
    })

  return observe(
    {
      services: [],
      plugins: [
        HotReload.use({
          entry: 'unused.ts',
          *load() {
            return [hot(greeting)]
          },
        }),
      ],
    },
    function* (server) {
      yield* HotReload.actions.reload()
      greeting = 'two'
      yield* HotReload.actions.reload()
      yield* server.call(refs<Hot>('hot').greet)
    },
  )
}

// --- a network carrier + a db queue -----------------------------------------------------------

const vaultSchema = defineSchema({ todosTable, jobs: queueTable('jobs') })

const vault = service('vault', {
  put: action.mutation(
    { input: z.object({ text: z.string() }), output: z.string() },
    function* ({ input }) {
      const { job } = yield* Queue.actions.enqueue('index', { text: input.text })

      yield* Queue.actions.enqueue('broken', { text: input.text }, { maxAttempts: 2 })

      return job._id
    },
  ),
  kaput: action.query({ output: z.string() }, function* () {
    return yield* fail('vault.kaput', 'the vault is kaput')
  }),
})

const front = service('front', {
  put: action.mutation(
    { input: z.object({ text: z.string() }), output: z.string() },
    function* ({ input, ctx }) {
      return yield* ctx.call(vault, 'put', input)
    },
  ),
  kaput: action.query({ output: z.string() }, function* ({ ctx }) {
    return yield* ctx.call(vault, 'kaput')
  }),
})

/** Node a (`front`) calls node b (`vault`, a queue + its worker) over a MemoryTransport link. */
const carrierTraffic = async (): Promise<ObserveDef.Event[]> => {
  const link = createLink()
  const a = memoryExporter()
  const b = memoryExporter()
  const dead = () =>
    b.seen.some(
      seen => seen.t === 'span' && seen.span.events.some(item => item.name === 'queue.dead'),
    )

  unwrap(
    await run(function* () {
      const ready = createQueue<void, void>()
      const remote = yield* fork(() =>
        scoped(function* () {
          yield* MemoryAdapter.use()
          yield* BunIO.use()
          yield* DbClient.use({ schema: vaultSchema })
          yield* MemoryKv.use()
          yield* MemoryTransport.use({ prefix: 'contract', link })
          yield* DefaultLogger.use({ level: LogLevel.info })
          yield* Queue.use({ table: 'jobs' })
          yield* createServer({
            services: [vault],
            carrier: NetworkCarrier,
            name: 'contract',
            instance: 'b',
            plugins: [b.plugin],
          })
          yield* Queue.actions.work(
            {
              *index() {},
              *broken() {
                return yield* fail('vault.job', 'the job failed')
              },
            },
            { pollMs: 10, backoff: { kind: 'linear', stepMs: 1 } },
          )
          ready.add(undefined)
          yield* sleep(60_000)
        }),
      )

      yield* ready.next()
      yield* scoped(function* () {
        yield* storage()
        yield* MemoryTransport.use({ prefix: 'contract', link })
        yield* DefaultLogger.use({ level: LogLevel.info })

        const server = yield* createServer({
          services: [front],
          carrier: NetworkCarrier,
          name: 'contract',
          instance: 'a',
          timeoutMs: 2000,
          plugins: [a.plugin],
        })

        yield* sleep(50)
        yield* server.call(front, 'put', { text: 'hello' })
        yield* attempt(server.call(front, 'kaput'))

        for (let at = 0; at < 400 && !dead(); at += 1) {
          yield* sleep(5)
        }
      })
      yield* remote.halt()
    }),
  )

  return [...a.seen, ...b.seen]
}

/** Every plugin's traffic, in turn: the events each node observed, by plugin. */
export const runPluginTraffic = async (): Promise<Record<string, ObserveDef.Event[]>> => ({
  auth: await authTraffic(),
  cors: await corsTraffic(),
  cache: await cacheTraffic(),
  resilience: await resilienceTraffic(),
  crud: await crudTraffic(),
  hotReload: await hotTraffic(),
  carrier: await carrierTraffic(),
})
