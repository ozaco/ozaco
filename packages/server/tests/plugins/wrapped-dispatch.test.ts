/**
 * Dispatch-level plugin telemetry lands on the DISPATCH span (`dispatchSpan()`), never on a plugin
 * span that wraps the chain: with `Cache` installed first, every later plugin's dispatch hook runs
 * inside the `cache {service}.{action}` span — yet `ozaco.auth.*` (+ the `ozaco.auth.skip`
 * events), `ozaco.resilience.*` (timeout, rate limit, singleflight + its follower link, fallback,
 * the retried attempt's WARN record, the breaker's events + its `breaker.trip` link) and
 * `ozaco.crud.scoped` / `ozaco.crud.recovered` (+ the hook event and the swallowed failure's record)
 * all belong to the dispatch span; the cache span keeps only its own `ozaco.cache.*` keys and its
 * producer link. The same holds for Cache's own `ozaco.cache.evict` under a plugin span wrapping
 * IT (a Resilience retry attempt).
 */
import { where } from 'db:core'
import type { ServerDef, ServiceDef } from 'server:core'
import { action, createServer, ServerErrors, service } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Auth, AuthStrategy, Cache, crud, Resilience, StaticAuth } from 'server:plugins'
import type { Operation } from 'std:effect'
import { all, attempt, run, sleep } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { enableTracing, Tracer } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage, todosTable } from '../helpers'

let installs = 0

/** An in-memory std:trace `Tracer` installed around the server: every span and log record. */
const memoryTracer = () => {
  installs += 1
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Tracer.implement({
    name: `test/wrapped-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit(log: TraceDef.LogData) {
      logs.push(log)
    },
  })

  const named = (name: string): TraceDef.SpanData[] => spans.filter(data => data.name === name)

  /** The cache span directly under `dispatch`. */
  const cacheOf = (dispatch: TraceDef.SpanData): TraceDef.SpanData => {
    const found = spans.filter(
      data =>
        data.name === `cache ${dispatch.name}` && data.parent?.spanId === dispatch.context.spanId,
    )
    expect(found).toHaveLength(1)
    return found[0]!
  }

  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, named, cacheOf, exceptions }
}

/** The attribute keys under `prefix` a span carries. */
const keysOf = (data: TraceDef.SpanData, prefix: string): string[] =>
  Object.keys(data.attributes).filter(key => key.startsWith(prefix))

const reasonOf = (link: TraceDef.Link): unknown => link.attributes?.['ozaco.link.reason']

/** A strategy that FAILS on `tok-ui` before StaticAuth answers it (→ `ozaco.auth.skip`). */
const Flaky = AuthStrategy.implement<AuthDef.StrategyContext, []>({
  name: 'test-wrapped-flaky',
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

const tokens = StaticAuth.use({ tokens: { 'tok-ui': { sub: 'ui' } } })

const as = (key: string) => ({ meta: { authorization: 'Bearer tok-ui', 'x-k': key } })

/** Boot a node (Cache FIRST: it wraps every later plugin's hook) and run `body` against it. */
const withServer = async (
  services: readonly ServiceDef.Service[],
  plugins: readonly ServerDef.PluginLike[],
  body: (server: ServerDef.Handle<AnyType>) => Operation<void>,
) => {
  const tracer = memoryTracer()

  unwrap(
    await run(function* () {
      yield* storage()
      yield* tracer.plugin.use()
      const server = yield* createServer({ services: [...services], plugins: [...plugins] })
      yield* body(server as ServerDef.Handle<AnyType>)
    }),
  )

  return tracer
}

describe('dispatch-level telemetry under a wrapping cache span', () => {
  it('auth + timeout + rate limit + singleflight (and its follower link) are the dispatch span`s', async () => {
    const svc = service('w', {
      shared: action.query(
        {
          input: z.object({ id: z.string() }),
          output: z.string(),
          auth: 'user',
          // one cache entry per `x-k`: two callers miss side by side, singleflight joins them
          cache: { ttlMs: 10_000, vary: ['input.id', 'headers.x-k'] },
          timeoutMs: 5000,
          rateLimit: { limit: 10, windowMs: 60_000 },
          singleflight: true,
        },
        function* ({ input }) {
          yield* sleep(30)
          return input.id
        },
      ),
    })

    const tracer = await withServer(
      [svc],
      [Flaky.use(), tokens, Cache, Auth, Resilience],
      function* (server) {
        const both = yield* all([
          server.call(svc, 'shared', { id: 'a' }, as('1')),
          server.call(svc, 'shared', { id: 'a' }, as('2')),
        ])
        expect(both).toEqual(['a', 'a'])
      },
    )

    const dispatches = tracer.named('w.shared')
    expect(dispatches).toHaveLength(2)
    const leader = dispatches.find(
      data => data.attributes['ozaco.resilience.singleflight'] === 'leader',
    )!
    const follower = dispatches.find(
      data => data.attributes['ozaco.resilience.singleflight'] === 'follower',
    )!
    expect(leader).toBeDefined()
    expect(follower).toBeDefined()

    for (const dispatch of dispatches) {
      expect(dispatch.attributes).toMatchObject({
        'ozaco.auth.outcome': 'granted',
        'ozaco.auth.requirement': 'user',
        'ozaco.auth.strategy': 'static',
        'ozaco.resilience.timeout_ms': 5000,
        'ozaco.resilience.rate_limit.remaining': expect.any(Number),
      })
      // the strategy that failed before StaticAuth answered: on the guarded (dispatch) span
      expect(dispatch.events.filter(item => item.name === 'ozaco.auth.skip')).toHaveLength(1)

      // the cache span keeps ONLY its own keys — nothing of the plugins it wraps
      const cached = tracer.cacheOf(dispatch)
      expect(keysOf(cached, 'ozaco.auth.')).toEqual([])
      expect(keysOf(cached, 'ozaco.resilience.')).toEqual([])
      expect(cached.events.map(item => item.name)).toEqual([])
      expect(cached.links).toEqual([])
      expect(keysOf(cached, 'ozaco.cache.').toSorted()).toEqual([
        'ozaco.cache.coalesced',
        'ozaco.cache.hit',
        'ozaco.cache.key',
        'ozaco.cache.store',
        'ozaco.cache.ttl_ms',
      ])
    }

    // the follower LINKS the leader's DISPATCH span (not its cache span)
    const joined = follower.links.filter(link => reasonOf(link) === 'singleflight')
    expect(joined).toHaveLength(1)
    expect(joined[0]!.context.spanId).toBe(leader.context.spanId)
  })

  it('fallback flag, the retried attempt`s WARN and the breaker (events + trip link) are the dispatch span`s', async () => {
    let calls = 0
    const svc = service('w', {
      flaky: action.query(
        {
          output: z.string(),
          cache: { ttlMs: 10_000 },
          retry: { times: 1, delayMs: 1 },
          *fallback() {
            return 'fallback'
          },
        },
        function* () {
          calls += 1
          return yield* fail(ServerErrors.Unavailable, `down #${calls}`)
        },
      ),
      brittle: action.query(
        { output: z.string(), cache: { ttlMs: 10_000 }, breaker: { failures: 1 } },
        function* () {
          return yield* fail('w.broken', 'broken')
        },
      ),
    })

    const tracer = await withServer([svc], [Cache, Resilience], function* (server) {
      expect(yield* server.call(svc, 'flaky')).toBe('fallback')
      // trips the circuit, then fails fast
      expect((yield* attempt(server.call(svc, 'brittle'))) as AnyType).toMatchObject({
        error: 'w.broken',
      })
      expect((yield* attempt(server.call(svc, 'brittle'))) as AnyType).toMatchObject({
        error: ServerErrors.Unavailable,
      })
    })

    // fallback: the flag on the dispatch span, never the cache span
    const [flaky] = tracer.named('w.flaky')
    expect(flaky!.attributes['ozaco.resilience.fallback']).toBe(true)
    expect(keysOf(tracer.cacheOf(flaky!), 'ozaco.resilience.')).toEqual([])

    // attempt 1 (retried): its failure recorded handled (WARN) on the dispatch span
    const first = tracer.exceptions().filter(log => log.body.includes('down #1'))
    expect(first).toHaveLength(1)
    expect(first[0]!.severityNumber).toBe(13)
    expect(first[0]!.context?.spanId).toBe(flaky!.context.spanId)

    // breaker: the transition event on the tripping call's dispatch span; the fail-fast call's
    // dispatch span LINKS that dispatch span
    const [tripping, rejected] = tracer.named('w.brittle')
    expect(tripping!.events.map(item => item.name)).toContain('ozaco.breaker')
    // (the failure's own `exception` event sits where it first escaped: the cache span)
    expect(tracer.cacheOf(tripping!).events.map(item => item.name)).not.toContain('ozaco.breaker')
    const trips = rejected!.links.filter(link => reasonOf(link) === 'breaker.trip')
    expect(trips).toHaveLength(1)
    expect(trips[0]!.context.spanId).toBe(tripping!.context.spanId)
    expect(tracer.cacheOf(rejected!).links).toEqual([])

    // the transition's record is correlated to the dispatch span too
    const opened = tracer.logs.find(log => log.eventName === 'ozaco.breaker')
    expect(opened?.context?.spanId).toBe(tripping!.context.spanId)
  })

  it('crud: ozaco.crud.scoped / .recovered, the hook event and the swallowed miss are the dispatch span`s', async () => {
    const todos = crud(todosTable, {
      *scope() {
        return where.eq('done', false)
      },
      ops: { list: { cache: { ttlMs: 10_000 } }, get: { cache: { ttlMs: 10_000 } } },
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
    })

    const tracer = await withServer([todos], [Cache], function* (server) {
      yield* server.call(todos, 'list', {})
      expect(((yield* server.call(todos, 'get', { id: 'nope' })) as AnyType).title).toBe('ghost')
    })

    const [list] = tracer.named('todos.list')
    expect(list!.attributes['ozaco.crud.scoped']).toBe(true)
    expect(keysOf(tracer.cacheOf(list!), 'ozaco.crud.')).toEqual([])

    const [get] = tracer.named('todos.get')
    expect(get!.attributes['ozaco.crud.recovered']).toBe(true)
    expect(get!.events.map(item => item.name)).toContain('ozaco.crud.hook')
    const cached = tracer.cacheOf(get!)
    expect(keysOf(cached, 'ozaco.crud.')).toEqual([])
    expect(cached.events.map(item => item.name)).toEqual([])

    // the miss the hook swallowed: ONE WARN record on the dispatch span
    const misses = tracer
      .exceptions()
      .filter(log => log.attributes['exception.type'] === ServerErrors.NotFound)
    expect(misses.map(log => [log.severityNumber, log.context?.spanId])).toEqual([
      [13, get!.context.spanId],
    ])
  })

  it('cache: a mutation`s ozaco.cache.evict lands on its dispatch span under a retry attempt span', async () => {
    let calls = 0
    const svc = service('w', {
      bump: action.mutation(
        { invalidate: ['todos'], retry: { times: 1, delayMs: 1 } },
        function* () {
          calls += 1
          if (calls === 1) {
            return yield* fail(ServerErrors.Unavailable, 'not yet')
          }
        },
      ),
    })

    // Resilience FIRST: attempt 2 runs Cache's hook inside a `resilience.attempt` span
    const tracer = await withServer([svc], [Resilience, Cache], function* (server) {
      yield* server.call(svc, 'bump')
    })

    const [bump] = tracer.named('w.bump')
    const [retried] = tracer.named('resilience.attempt')
    expect(retried!.parent?.spanId).toBe(bump!.context.spanId)
    expect(bump!.events.map(item => item.name)).toContain('ozaco.cache.evict')
    expect(retried!.events.map(item => item.name)).not.toContain('ozaco.cache.evict')
  })
})
