/**
 * Auth's telemetry (design §7): every gate says its verdict on the span it guards — the dispatch
 * span of an action, the edge span of a raw route — as `ozaco.auth.outcome` (granted | anonymous
 * | denied), `ozaco.auth.requirement` (its kind, never the roles) and `ozaco.auth.strategy` (who
 * decided the bearer); `enduser.id` only with the global `capture.enduser`; an `ozaco.auth.skip`
 * event per strategy that FAILED before a later one answered. A denial stays the call's own
 * failure: 401 / 403 ⇒ status unset + `error.type`, one WARN exception record.
 */
import type { ServerDef } from 'server:core'
import { action, createServer, Edge, Server, ServerErrors, service } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Auth, AuthStrategy, StaticAuth } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, run, sleep, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { enableTracing, Tracer } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from '../helpers'

let installs = 0

/** An in-memory std:trace `Tracer` installed around the server: every exported span and log. */
const memoryTracer = () => {
  installs += 1
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Tracer.implement({
    name: `test/auth-tracer-${installs}`,
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

  /** the ONE exported span named `name`. */
  const span = (name: string): TraceDef.SpanData => {
    const found = spans.filter(data => data.name === name)
    expect(found.map(data => data.name)).toEqual([name])
    return found[0]!
  }

  /** the exported spans named `name`, oldest first. */
  const named = (name: string): TraceDef.SpanData[] => spans.filter(data => data.name === name)

  /** exception records correlated to a trace. */
  const exceptionsIn = (traceId: string): TraceDef.LogData[] =>
    logs.filter(
      log => log.context?.traceId === traceId && log.attributes['exception.type'] !== undefined,
    )

  return { plugin, spans, logs, span, named, exceptionsIn }
}

type Memory = ReturnType<typeof memoryTracer>

const app = service('app', {
  open: action.query({ output: z.string() }, function* () {
    return 'anyone'
  }),
  me: action.query({ output: z.string(), auth: 'user' }, function* ({ ctx }) {
    return (ctx.auth as AuthDef.Principal).sub
  }),
  admin: action.query({ output: z.string(), auth: ['admin'] }, function* () {
    return 'secret'
  }),
  shaped: action.query(
    { output: z.string(), auth: { permissions: ['agents:view'] } },
    function* () {
      return 'shaped'
    },
  ),
  vetted: action.query(
    {
      output: z.string(),
      auth: (principal: unknown) => (principal as AuthDef.Principal).sub === 'ui',
    },
    function* () {
      return 'vetted'
    },
  ),
  internal: action.query({ output: z.string(), auth: 'service' }, function* () {
    return 'internal'
  }),
})

const tokens = StaticAuth.use({
  tokens: {
    'tok-ui': { sub: 'ui', roles: ['admin'], permissions: ['agents:view'] },
    'tok-guest': { sub: 'guest' },
  },
})

const bearer = (token: string) => ({ meta: { authorization: `Bearer ${token}` } })

/** Boot a node with `app` under the in-memory tracer and run `body` against it. */
const withServer = async (
  options: Partial<ServerDef.Options>,
  body: (server: ServerDef.Handle<AnyType>) => Operation<void>,
): Promise<Memory> => {
  const memory = memoryTracer()

  unwrap(
    await run(function* () {
      yield* storage()
      yield* memory.plugin.use()
      const server = yield* createServer({
        services: [app],
        plugins: [tokens, Auth],
        ...options,
      })
      yield* body(server)
    }),
  )

  return memory
}

/** One in-process request, its body read to the end (a raw route's edge span ends with it). */
function* request(path: string, init?: RequestInit): Operation<number> {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))
  yield* until(response.text())
  // the span of a streamed body ends from the edge's scope: let that run
  yield* sleep(5)
  return response.status
}

describe('auth trace — the dispatch span', () => {
  it('says granted / anonymous with the requirement kind and the strategy that decided', async () => {
    const memory = await withServer({}, function* (server) {
      expect(yield* server.call(app, 'me', undefined, bearer('tok-ui'))).toBe('ui')
      expect(yield* server.call(app, 'open')).toBe('anyone')
      expect(yield* server.call(app, 'admin', undefined, bearer('tok-ui'))).toBe('secret')
      expect(yield* server.call(app, 'shaped', undefined, bearer('tok-ui'))).toBe('shaped')
      expect(yield* server.call(app, 'vetted', undefined, bearer('tok-ui'))).toBe('vetted')
    })

    expect(memory.span('app.me').attributes).toMatchObject({
      'ozaco.auth.outcome': 'granted',
      'ozaco.auth.requirement': 'user',
      'ozaco.auth.strategy': 'static',
    })
    // personal data stays out unless capture.enduser says otherwise
    expect(memory.span('app.me').attributes['enduser.id']).toBeUndefined()

    const open = memory.span('app.open').attributes
    expect(open['ozaco.auth.outcome']).toBe('anonymous')
    expect(open['ozaco.auth.requirement']).toBe('open')
    expect(open['ozaco.auth.strategy']).toBeUndefined()

    // the KIND of the requirement, never the roles / permissions themselves
    expect(memory.span('app.admin').attributes['ozaco.auth.requirement']).toBe('roles')
    expect(memory.span('app.shaped').attributes['ozaco.auth.requirement']).toBe('requirements')
    expect(memory.span('app.vetted').attributes['ozaco.auth.requirement']).toBe('predicate')
    expect(JSON.stringify(memory.span('app.admin').attributes)).not.toContain('"admin"')

    // no skip without a failing strategy; a granted call is no failure
    for (const data of memory.spans) {
      expect(data.events.map(item => item.name)).not.toContain('ozaco.auth.skip')
      expect(data.status.code).toBe('unset')
    }
    expect(memory.logs.filter(log => log.attributes['exception.type'] !== undefined)).toEqual([])
  })

  it('a denial is the call failing: denied + error.type, status unset, ONE WARN exception', async () => {
    const memory = await withServer({}, function* (server) {
      const missing = yield* attempt(server.call(app, 'me'))
      expect((missing as AnyType).error).toBe(ServerErrors.Unauthorized)
      const unknown = yield* attempt(server.call(app, 'me', undefined, bearer('nope')))
      expect((unknown as AnyType).error).toBe(ServerErrors.Unauthorized)
      const role = yield* attempt(server.call(app, 'admin', undefined, bearer('tok-guest')))
      expect((role as AnyType).error).toBe(ServerErrors.Forbidden)
      // an unknown bearer is refused even where nothing is required (a stale token is news)
      const stale = yield* attempt(server.call(app, 'open', undefined, bearer('nope')))
      expect((stale as AnyType).error).toBe(ServerErrors.Unauthorized)
    })

    const [missing, unknown] = memory.named('app.me')
    expect(missing!.attributes).toMatchObject({
      'ozaco.auth.outcome': 'denied',
      'ozaco.auth.requirement': 'user',
      'error.type': ServerErrors.Unauthorized,
    })
    // nobody recognized the bearer: no strategy decided it
    expect(missing!.attributes['ozaco.auth.strategy']).toBeUndefined()
    expect(unknown!.attributes['ozaco.auth.outcome']).toBe('denied')
    expect(unknown!.attributes['ozaco.auth.strategy']).toBeUndefined()

    // a known principal refused by the requirement: the strategy that knew it is named
    expect(memory.span('app.admin').attributes).toMatchObject({
      'ozaco.auth.outcome': 'denied',
      'ozaco.auth.requirement': 'roles',
      'ozaco.auth.strategy': 'static',
      'error.type': ServerErrors.Forbidden,
    })
    expect(memory.span('app.open').attributes).toMatchObject({
      'ozaco.auth.outcome': 'denied',
      'ozaco.auth.requirement': 'open',
    })

    // 4xx: a client-caused failure — status unset, one WARN (13) record per denied call
    for (const data of [...memory.named('app.me'), memory.span('app.admin')]) {
      expect(data.status.code).toBe('unset')
      const exceptions = memory.exceptionsIn(data.context.traceId)
      expect(exceptions).toHaveLength(1)
      expect(exceptions[0]!.severityNumber).toBe(13)
      expect(exceptions[0]!.eventName).toBe('ozaco.action.exception')
    }
  })

  it('`enduser.id` only with the global capture.enduser — on the verdict of a known principal', async () => {
    const memory = await withServer(
      { observe: { capture: { enduser: true } } },
      function* (server) {
        yield* server.call(app, 'me', undefined, bearer('tok-ui'))
        yield* server.call(app, 'open')
        yield* attempt(server.call(app, 'admin', undefined, bearer('tok-guest')))
      },
    )

    expect(memory.span('app.me').attributes['enduser.id']).toBe('ui')
    expect(memory.span('app.open').attributes['enduser.id']).toBeUndefined()
    // a refused principal is still who called
    expect(memory.span('app.admin').attributes['enduser.id']).toBe('guest')
  })
})

describe('auth trace — the strategy chain', () => {
  it('a strategy that FAILED before a later one answered leaves ozaco.auth.skip', async () => {
    const Flaky = AuthStrategy.implement<AuthDef.StrategyContext, []>({
      name: 'test-flaky',
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

    const memory = await withServer({ plugins: [Flaky.use(), tokens, Auth] }, function* (server) {
      expect(yield* server.call(app, 'me', undefined, bearer('tok-ui'))).toBe('ui')
      // "not mine" is no failure: no skip for a strategy that merely did not know the token
      expect(yield* server.call(app, 'admin', undefined, bearer('tok-ui'))).toBe('secret')
    })

    const me = memory.span('app.me')
    expect(me.attributes['ozaco.auth.outcome']).toBe('granted')
    expect(me.attributes['ozaco.auth.strategy']).toBe('static')
    const skips = me.events.filter(item => item.name === 'ozaco.auth.skip')
    expect(skips).toHaveLength(1)
    expect(skips[0]!.attributes).toEqual({
      'ozaco.auth.strategy': 'flaky',
      'error.type': ServerErrors.Unavailable,
    })
    // the skipped failure was not the answer: nothing recorded, nothing red
    expect(me.status.code).toBe('unset')
    expect(memory.exceptionsIn(me.context.traceId)).toEqual([])
  })

  it('the first failure is the answer when nobody succeeds — its strategy decided', async () => {
    const Gone = AuthStrategy.implement<AuthDef.StrategyContext, []>({
      name: 'test-gone',
      version: '0.0.0',
      description: 'refuses every token',
      *setup() {
        return { strategy: 'gone' }
      },
    }).build({
      *verify() {
        return yield* fail(ServerErrors.Unauthorized, 'revoked')
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

    const memory = await withServer({ plugins: [Gone.use(), tokens, Auth] }, function* (server) {
      const refused = yield* attempt(server.call(app, 'me', undefined, bearer('nope')))
      expect((refused as AnyType).message).toBe('revoked')
    })

    expect(memory.span('app.me').attributes).toMatchObject({
      'ozaco.auth.outcome': 'denied',
      'ozaco.auth.strategy': 'gone',
    })
    expect(memory.span('app.me').events).toEqual([expect.objectContaining({ name: 'exception' })])
  })
})

describe('auth trace — raw routes and handshakes', () => {
  it('a raw route guard says its verdict on the EDGE span', async () => {
    const memory = await withServer({ edge: BunEdge }, function* (server) {
      yield* server.start()
      const whoami = function* (
        _request: Request,
        _params: Readonly<Record<string, string>>,
        { principal }: { principal: AuthDef.Principal | null },
      ) {
        return new Response(principal?.sub ?? 'anonymous')
      }
      yield* Edge.actions.raw({ method: 'GET', path: '/private', auth: 'user', handler: whoami })
      yield* Edge.actions.raw({ method: 'GET', path: '/public', auth: false, handler: whoami })

      expect(yield* request('/private', { headers: { authorization: 'Bearer tok-ui' } })).toBe(200)
      expect(yield* request('/private')).toBe(401)
      // a public route serves a stale bearer anonymously — the refusal is still said
      expect(yield* request('/public', { headers: { authorization: 'Bearer nope' } })).toBe(200)
      yield* server.stop()
    })

    const [granted, denied] = memory.named('GET /private')
    expect(granted!.kind).toBe('server')
    expect(granted!.attributes).toMatchObject({
      'ozaco.auth.outcome': 'granted',
      'ozaco.auth.requirement': 'user',
      'ozaco.auth.strategy': 'static',
    })
    expect(denied!.attributes).toMatchObject({
      'ozaco.auth.outcome': 'denied',
      'ozaco.auth.requirement': 'user',
      'error.type': ServerErrors.Unauthorized,
      'http.response.status_code': 401,
    })
    expect(denied!.status.code).toBe('unset')

    expect(memory.span('GET /public').attributes).toMatchObject({
      'ozaco.auth.outcome': 'anonymous',
      'ozaco.auth.requirement': 'open',
    })
  })

  it('`Auth.actions.authorize` / `check` (socket handshakes, seams) say it on the active span', async () => {
    const memory = await withServer({}, function* () {
      yield* Server.actions.span('handshake', function* () {
        yield* Auth.actions.authorize('user', { authorization: 'Bearer tok-ui' })
      })
      yield* Server.actions.span('question', function* () {
        expect(yield* Auth.actions.check(['root'], { authorization: 'Bearer tok-ui' })).toBeNull()
      })
    })

    expect(memory.span('handshake').attributes).toMatchObject({
      'ozaco.auth.outcome': 'granted',
      'ozaco.auth.requirement': 'user',
      'ozaco.auth.strategy': 'static',
    })
    expect(memory.span('question').attributes).toMatchObject({
      'ozaco.auth.outcome': 'denied',
      'ozaco.auth.requirement': 'roles',
    })
  })
})
