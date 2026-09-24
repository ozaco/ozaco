import { action, createServer, Edge, ServerErrors, service } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Auth, AuthErrors, JwtAuth, StaticAuth } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, run, sleep } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from '../helpers'

/** An in-memory provider with refresh rotation (tombstoned records, family revocation). */
const provider = (): AuthDef.Provider & { refreshes: Map<string, AuthDef.RefreshRecord> } => {
  const refreshes = new Map<string, AuthDef.RefreshRecord>()
  return {
    refreshes,
    *authenticate(credentials) {
      return credentials.user === 'ada' && credentials.pass === 'pw'
        ? { sub: 'u-ada', roles: ['admin'], permissions: ['agents:view'], claims: { name: 'Ada' } }
        : undefined
    },
    *loadUser(sub) {
      return sub === 'u-ada'
        ? { sub, roles: ['admin'], permissions: ['agents:view'], claims: { name: 'Ada' } }
        : undefined
    },
    *saveRefresh(record) {
      refreshes.set(record.jti, record)
    },
    *loadRefresh(jti) {
      return refreshes.get(jti)
    },
    *rotateRefresh(expectedJti, next) {
      const current = refreshes.get(expectedJti)
      if (!current || current.revoked) {
        return false
      }
      refreshes.set(expectedJti, { ...current, revoked: true })
      refreshes.set(next.jti, next)
      return true
    },
    *revokeFamily(family) {
      for (const [jti, record] of refreshes) {
        if (record.family === family) {
          refreshes.set(jti, { ...record, revoked: true })
        }
      }
    },
  }
}

const app = service('app', {
  open: action.query({ output: z.string() }, function* () {
    return 'anyone'
  }),
  me: action.query(
    { output: z.object({ sub: z.string(), name: z.string() }), auth: 'user' },
    function* ({ ctx }) {
      const principal = ctx.auth as AuthDef.Principal
      return { sub: principal.sub, name: String(principal.claims.name) }
    },
  ),
  admin: action.query({ output: z.string(), auth: ['admin'] }, function* () {
    return 'secret'
  }),
  root: action.query({ output: z.string(), auth: ['root'] }, function* () {
    return 'never'
  }),
  internal: action.query({ output: z.string(), auth: 'service' }, function* ({ ctx }) {
    return (ctx.auth as AuthDef.Principal).sub
  }),
  login: action.mutation(
    {
      input: z.object({ user: z.string(), pass: z.string() }),
      output: z.object({ accessToken: z.string(), refreshToken: z.string().optional() }),
    },
    function* ({ input }) {
      return yield* Auth.actions.login(input)
    },
  ),
})

/** Nested-call fixture: `who` needs a user; the relays call it with and without `inherit`. */
const relaySvc = service('relay', {
  who: action.query({ output: z.string(), auth: 'user' }, function* ({ ctx }) {
    return (ctx.auth as AuthDef.Principal).sub
  }),
  viaInherit: action.query({ output: z.string() }, function* ({ ctx }): Operation<string> {
    return yield* ctx.call(relaySvc, 'who', undefined, { inherit: true })
  }),
  viaPlain: action.query({ output: z.string() }, function* ({ ctx }): Operation<string> {
    const out = yield* attempt(() => ctx.call(relaySvc, 'who'))
    return isFailure(out) ? String(out.error) : 'leaked?!'
  }),
})

/** Service-level default: every action is admin-only unless it opts out. */
const vault = service(
  'vault',
  {
    secrets: action.query({ output: z.string() }, function* () {
      return 'vault'
    }),
    status: action.query({ output: z.string(), auth: false }, function* () {
      return 'up'
    }),
  },
  { auth: ['admin'] },
)

describe('auth', () => {
  it('static tokens authenticate without a provider or JWTs; `default` fails closed; a service-level `auth` covers its actions', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [app, vault],
          edge: BunEdge,
          plugins: [
            StaticAuth.use({
              tokens: {
                'tok-ui': { sub: 'ui', roles: ['admin'] },
                'tok-mcp': { sub: 'service:mcp', type: 'service' },
              },
            }),
            Auth.use({ default: 'authenticated' }),
          ],
        })
        const ui = { meta: { authorization: 'Bearer tok-ui' } }
        const mcp = { meta: { authorization: 'Bearer tok-mcp' } }

        // `open` declares nothing → the install default applies: anonymous is refused
        const anonymous = yield* attempt(server.call(app, 'open'))
        expect((anonymous as AnyType).error).toBe(ServerErrors.Unauthorized)
        expect(yield* server.call(app, 'open', undefined, ui)).toBe('anyone')

        // a static token is a full principal: sub/roles/type gate like a JWT would
        expect(yield* server.call(app, 'admin', undefined, ui)).toBe('secret')
        expect(yield* server.call(app, 'internal', undefined, mcp)).toBe('service:mcp')
        const notService = yield* attempt(server.call(app, 'internal', undefined, ui))
        expect((notService as AnyType).error).toBe(ServerErrors.Forbidden)
        expect(yield* Auth.actions.verify('tok-mcp')).toMatchObject({
          sub: 'service:mcp',
          type: 'service',
          jti: 'static:service:mcp',
        })

        // an unknown bearer is unauthorized — there is no JWT material to fall back to
        const unknown = yield* attempt(
          server.call(app, 'open', undefined, { meta: { authorization: 'Bearer nope' } }),
        )
        expect((unknown as AnyType).error).toBe(ServerErrors.Unauthorized)
        expect((unknown as AnyType).causes).toContain(AuthErrors.InvalidToken)

        // minting needs a provider / key material: a configuration failure, not a crash
        const login = yield* attempt(Auth.actions.login({ user: 'ada', pass: 'pw' }))
        expect((login as AnyType).error).toBe(ServerErrors.Configuration)
        const minted = yield* attempt(Auth.actions.signService('x'))
        expect((minted as AnyType).error).toBe(ServerErrors.Configuration)

        // the service-level requirement is stamped on its actions (and visible on the meta)…
        expect(vault.actions.secrets.meta.options['auth']).toEqual(['admin'])
        expect(vault.actions.status.meta.options['auth']).toBe(false)
        expect(yield* server.call(vault, 'secrets', undefined, ui)).toBe('vault')
        const wrongRole = yield* attempt(server.call(vault, 'secrets', undefined, mcp))
        expect((wrongRole as AnyType).error).toBe(ServerErrors.Forbidden)
        // …and `auth: false` on an action opens it back up, past the install default too
        expect(yield* server.call(vault, 'status')).toBe('up')

        // the same over the edge
        yield* server.start()
        const denied = yield* Edge.actions.handle(new Request('http://edge/app/open'))
        expect(denied.status).toBe(401)
        const allowed = yield* Edge.actions.handle(
          new Request('http://edge/app/open', { headers: { authorization: 'Bearer tok-ui' } }),
        )
        expect(allowed.status).toBe(200)
        const status = yield* Edge.actions.handle(new Request('http://edge/vault/status'))
        expect(status.status).toBe(200)
        yield* server.stop()
      }),
    )
  })

  it('strategies chain: the first SUCCESSFUL answer wins, a failing one does not stop the next', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [app],
          plugins: [
            JwtAuth.use({ provider: provider(), secret: 'test-secret', sessionTtlMs: 1000 }),
            StaticAuth.use({ tokens: { 'tok-ui': { sub: 'ui', roles: ['admin'] } } }),
            Auth,
          ],
        })
        // a JWT and a static token both authenticate — each through its own strategy
        const tokens = yield* server.call(app, 'login', { user: 'ada', pass: 'pw' })
        expect(
          yield* server.call(app, 'me', undefined, {
            meta: { authorization: `Bearer ${tokens.accessToken}` },
          }),
        ).toMatchObject({ sub: 'u-ada' })
        expect(
          yield* server.call(app, 'admin', undefined, { meta: { authorization: 'Bearer tok-ui' } }),
        ).toBe('secret')
        // the static strategy cannot log anyone in: the jwt one answers, wrong credentials
        // are ITS failure and nothing else could succeed → that failure is what comes back
        const bad = yield* attempt(Auth.actions.login({ user: 'ada', pass: 'nope' }))
        expect((bad as AnyType).error).toBe(ServerErrors.Unauthorized)
        expect((bad as AnyType).causes).toContain(AuthErrors.BadCredentials)
        // an expired JWT FAILS in the jwt strategy, yet the static strategy still gets asked:
        // a static bearer keeps working, and an unknown one surfaces the most specific failure
        yield* sleep(1100)
        expect(
          yield* server.call(app, 'admin', undefined, { meta: { authorization: 'Bearer tok-ui' } }),
        ).toBe('secret')
        const expired = yield* attempt(
          server.call(app, 'me', undefined, {
            meta: { authorization: `Bearer ${tokens.accessToken}` },
          }),
        )
        expect((expired as AnyType).error).toBe(ServerErrors.Unauthorized)
        expect((expired as AnyType).causes).toContain(AuthErrors.ExpiredToken)
      }),
    )
  })

  it('`check` answers a requirement with the principal or null — headers or a record, any casing', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({
          services: [app],
          plugins: [
            StaticAuth.use({
              tokens: {
                'tok-ui': { sub: 'ui', roles: ['admin'] },
                'tok-mcp': { sub: 'service:mcp', type: 'service' },
              },
            }),
            Auth,
          ],
        })
        const web = new Headers({ Authorization: 'Bearer tok-ui' })
        expect(yield* Auth.actions.check('authenticated', web)).toMatchObject({ sub: 'ui' })
        expect(
          yield* Auth.actions.check(['admin'], { Authorization: 'Bearer tok-ui' }),
        ).toMatchObject({ sub: 'ui' })
        expect(
          yield* Auth.actions.check('service', { authorization: 'Bearer tok-mcp' }),
        ).toMatchObject({ sub: 'service:mcp' })

        // every verdict is a value: missing, unknown, wrong type, missing role → null
        expect(yield* Auth.actions.check('authenticated', {})).toBeNull()
        expect(yield* Auth.actions.check('authenticated', new Headers())).toBeNull()
        expect(yield* Auth.actions.check('authenticated', { authorization: 'Bearer x' })).toBeNull()
        expect(yield* Auth.actions.check('service', web)).toBeNull()
        expect(yield* Auth.actions.check(['root'], web)).toBeNull()

        // open: anonymous is allowed and resolves null; a known bearer still resolves
        expect(yield* Auth.actions.check(false, {})).toBeNull()
        expect(yield* Auth.actions.check(false, web)).toMatchObject({ sub: 'ui' })

        // `authorize` takes the same shapes and still raises
        expect(yield* Auth.actions.authorize('authenticated', web)).toMatchObject({ sub: 'ui' })
        const refused = yield* attempt(Auth.actions.authorize('authenticated', new Headers()))
        expect((refused as AnyType).error).toBe(ServerErrors.Unauthorized)
      }),
    )
  })

  it('refuses Auth without a strategy, JwtAuth without key material, StaticAuth without a `sub`', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const alone = yield* attempt(createServer({ services: [app], plugins: [Auth] }))
        expect((alone as AnyType).error).toBe(ServerErrors.Configuration)
        const noKeys = yield* attempt(
          createServer({ services: [app], plugins: [JwtAuth.use({} as AnyType), Auth] }),
        )
        expect((noKeys as AnyType).error).toBe(ServerErrors.Configuration)
        const noSub = yield* attempt(
          createServer({
            services: [app],
            plugins: [StaticAuth.use({ tokens: { t: {} as AnyType } }), Auth],
          }),
        )
        expect((noSub as AnyType).error).toBe(ServerErrors.Configuration)
      }),
    )
  })

  it('session mode: bearer tokens become principals; action `auth` gates by user/roles/service', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [app],
          edge: BunEdge,
          plugins: [
            JwtAuth.use({ provider: provider(), secret: 'test-secret', sessionTtlMs: 60_000 }),
            Auth,
          ],
        })
        expect(yield* server.call(app, 'open')).toBe('anyone')
        const anonymous = yield* attempt(server.call(app, 'me'))
        expect((anonymous as AnyType).error).toBe(ServerErrors.Unauthorized)

        const bad = yield* attempt(server.call(app, 'login', { user: 'ada', pass: 'nope' }))
        expect((bad as AnyType).error).toBe(ServerErrors.Unauthorized)
        expect((bad as AnyType).causes).toContain(AuthErrors.BadCredentials)

        const tokens = yield* server.call(app, 'login', { user: 'ada', pass: 'pw' })
        const meta = { authorization: `Bearer ${tokens.accessToken}` }
        expect(yield* server.call(app, 'me', undefined, { meta })).toEqual({
          sub: 'u-ada',
          name: 'Ada',
        })
        expect(yield* server.call(app, 'admin', undefined, { meta })).toBe('secret')
        const forbidden = yield* attempt(server.call(app, 'root', undefined, { meta }))
        expect((forbidden as AnyType).error).toBe(ServerErrors.Forbidden)
        const notService = yield* attempt(server.call(app, 'internal', undefined, { meta }))
        expect((notService as AnyType).error).toBe(ServerErrors.Forbidden)

        // service tokens
        const serviceToken = yield* Auth.actions.signService('billing')
        expect(
          yield* server.call(app, 'internal', undefined, {
            meta: { authorization: `Bearer ${serviceToken}` },
          }),
        ).toBe('service:billing')
        // a garbage token is unauthorized, not a crash
        const garbage = yield* attempt(
          server.call(app, 'me', undefined, { meta: { authorization: 'Bearer nope' } }),
        )
        expect((garbage as AnyType).error).toBe(ServerErrors.Unauthorized)
        expect((garbage as AnyType).causes).toContain(AuthErrors.InvalidToken)

        // over the edge: the header travels into the dispatch
        yield* server.start()
        const http = yield* Edge.actions.handle(
          new Request('http://edge/app/me', {
            headers: { authorization: `Bearer ${tokens.accessToken}` },
          }),
        )
        expect(http.status).toBe(200)
        const denied = yield* Edge.actions.handle(new Request('http://edge/app/me'))
        expect(denied.status).toBe(401)
        yield* server.stop()
      }),
    )
  })

  it('access-refresh mode: rotation, expiry, replay revokes the family', async () => {
    const store = provider()
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [app],
          plugins: [
            JwtAuth.use({
              provider: store,
              secret: 'test-secret',
              mode: 'access-refresh',
              accessTtlMs: 1000,
              refreshTtlMs: 60_000,
            }),
            Auth,
          ],
        })
        const first = yield* server.call(app, 'login', { user: 'ada', pass: 'pw' })
        expect(first.refreshToken).toBeTruthy()
        // a refresh token cannot call actions
        const misuse = yield* attempt(
          server.call(app, 'me', undefined, {
            meta: { authorization: `Bearer ${first.refreshToken}` },
          }),
        )
        expect((misuse as AnyType).error).toBe(ServerErrors.Unauthorized)

        const second = yield* Auth.actions.refresh(first.refreshToken!)
        expect(second.refreshToken).not.toBe(first.refreshToken)
        expect(
          yield* server.call(app, 'me', undefined, {
            meta: { authorization: `Bearer ${second.accessToken}` },
          }),
        ).toMatchObject({ sub: 'u-ada' })

        // replaying the consumed token burns the family: the fresh one dies with it
        const replay = yield* attempt(Auth.actions.refresh(first.refreshToken!))
        expect((replay as AnyType).causes).toContain(AuthErrors.Replayed)
        const burned = yield* attempt(Auth.actions.refresh(second.refreshToken!))
        expect((burned as AnyType).causes).toContain(AuthErrors.Replayed)

        // access tokens expire (jose has second granularity)
        const short = yield* server.call(app, 'login', { user: 'ada', pass: 'pw' })
        yield* sleep(1100)
        const expired = yield* attempt(
          server.call(app, 'me', undefined, {
            meta: { authorization: `Bearer ${short.accessToken}` },
          }),
        )
        expect((expired as AnyType).causes).toContain(AuthErrors.ExpiredToken)
      }),
    )
  })

  it("requirements: 'authenticated', permissions and predicates", async () => {
    const gated = service('gated', {
      anyone: action.query({ output: z.string(), auth: 'authenticated' }, function* () {
        return 'in'
      }),
      viewer: action.query(
        { output: z.string(), auth: { permissions: ['agents:view'] } },
        function* () {
          return 'seen'
        },
      ),
      admin: action.query(
        { output: z.string(), auth: { roles: ['admin'], permissions: ['agents:admin'] } },
        function* () {
          return 'never'
        },
      ),
      custom: action.query(
        {
          output: z.string(),
          auth: (principal: AuthDef.Principal) => principal.claims.name === 'Ada',
        },
        function* () {
          return 'bespoke'
        },
      ),
    })
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [gated],
          plugins: [JwtAuth.use({ provider: provider(), secret: 'test-secret' }), Auth],
        })
        const tokens = yield* Auth.actions.login({ user: 'ada', pass: 'pw' })
        const meta = { authorization: `Bearer ${tokens.accessToken}` }

        // 'authenticated' and its deprecated alias 'any' mean the same thing
        expect(yield* server.call(gated, 'anyone', undefined, { meta })).toBe('in')
        const anonymous = yield* attempt(server.call(gated, 'anyone'))
        expect((anonymous as AnyType).error).toBe(ServerErrors.Unauthorized)

        // permissions gate independently of roles
        expect(yield* server.call(gated, 'viewer', undefined, { meta })).toBe('seen')
        const missing = yield* attempt(server.call(gated, 'admin', undefined, { meta }))
        expect((missing as AnyType).error).toBe(ServerErrors.Forbidden)
        expect((missing as AnyType).causes).toContain('server:auth.permission')

        // the predicate sees the FULL principal
        expect(yield* server.call(gated, 'custom', undefined, { meta })).toBe('bespoke')
      }),
    )
  })

  it('nested calls: `inherit: true` carries the caller authorization; plain calls stay anonymous', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [relaySvc],
          plugins: [JwtAuth.use({ provider: provider(), secret: 'test-secret' }), Auth],
        })
        const tokens = yield* Auth.actions.login({ user: 'ada', pass: 'pw' })
        const meta = { authorization: `Bearer ${tokens.accessToken}` }
        expect(yield* server.call(relaySvc, 'viaInherit', undefined, { meta })).toBe('u-ada')
        expect(yield* server.call(relaySvc, 'viaPlain', undefined, { meta })).toBe(
          ServerErrors.Unauthorized,
        )
      }),
    )
  })
})
