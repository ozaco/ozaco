import { action, createServer, Edge, ServerErrors, service } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Auth, AuthErrors } from 'server:plugins'
import { attempt, run, sleep } from 'std:effect'
import { unwrap } from 'std:result'
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
        ? { sub: 'u-ada', roles: ['admin'], claims: { name: 'Ada' } }
        : undefined
    },
    *loadUser(sub) {
      return sub === 'u-ada' ? { sub, roles: ['admin'], claims: { name: 'Ada' } } : undefined
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

describe('auth', () => {
  it('session mode: bearer tokens become principals; action `auth` gates by user/roles/service', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [app],
          edge: BunEdge,
          plugins: [
            Auth.use({ provider: provider(), secret: 'test-secret', sessionTtlMs: 60_000 }),
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
        yield* server.listen()
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
            Auth.use({
              provider: store,
              secret: 'test-secret',
              mode: 'access-refresh',
              accessTtlMs: 1000,
              refreshTtlMs: 60_000,
            }),
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
})
