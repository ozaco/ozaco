import { describe, expect, it } from 'bun:test'

import { Broker, DefaultBroker, defineAction, defineService, Gateway } from '@ozaco/server/core'
import { BunGateway } from '@ozaco/server/gateway/bun'
import type { AuthDef } from '@ozaco/server/plugin/auth'
import { AccessRefreshAuth, JWTSessionAuth } from '@ozaco/server/plugin/auth'
import { Docs } from '@ozaco/server/plugin/docs'
import { run, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { isSuccess } from '@ozaco/std/result'

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

const web = defineService({
  name: 'web',
  version: '0.0.0',
  actions: {
    ping: defineAction(
      { settings: [Gateway.actions.rest({ method: 'GET', path: '/ping' })] },
      function* () {
        return { ok: true }
      },
    ),
  },
  *setup() {},
})

describe('docs plugin', () => {
  it('serves an OpenAPI spec + swagger UI', async () => {
    const port = 39_010
    const ready = Promise.withResolvers<void>()
    const task = run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(BunGateway, { port })
      yield* install(web)
      yield* install(Docs, { title: 'Test API' })
      yield* Broker.actions.register(web)
      yield* Gateway.actions.mount('/web', web)
      yield* Docs.actions.from(web)
      yield* Broker.actions.start()
      yield* Gateway.actions.start({ port })
      ready.resolve()
      yield* suspend()
    })
    await ready.promise
    await wait(50)
    try {
      const spec = await fetch(`http://localhost:${port}/docs/openapi`)
      expect(spec.status).toBe(200)
      const json = await spec.json()
      expect(String(json.openapi)).toMatch(/^3\./u)
      expect(json.info.title).toBe('Test API')
      expect(Object.keys(json.paths).length).toBeGreaterThan(0)

      const ui = await fetch(`http://localhost:${port}/docs/swagger`)
      expect(ui.status).toBe(200)
      const html = await ui.text()
      expect(html.toLowerCase()).toContain('swagger')
    } finally {
      await task.halt()
    }
  })
})

describe('auth plugin (jwt session)', () => {
  it('signs in then authorizes the issued JWT', async () => {
    const provider: AuthDef.Provider = {
      *authenticate(credentials) {
        const creds = credentials as { username?: string }
        return creds.username === 'mona' ? { id: 'u1', name: 'Mona' } : null
      },
      *loadUser(id) {
        return id === 'u1' ? { id: 'u1', name: 'Mona' } : null
      },
    }

    const outcome = await run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(JWTSessionAuth, { secret: 'test-secret-please-change' })
      yield* JWTSessionAuth.actions.provide(provider)

      const signedIn = yield* JWTSessionAuth.actions.signIn({ username: 'mona' })
      const session = yield* JWTSessionAuth.actions.authorize(signedIn.token)

      return { token: signedIn.token, sub: session.sub, userId: session.user.id }
    })

    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(typeof outcome.value.token).toBe('string')
      expect(outcome.value.sub).toBe('u1')
      expect(outcome.value.userId).toBe('u1')
    }
  })

  it('rejects bad credentials', async () => {
    const provider: AuthDef.Provider = {
      *authenticate() {
        return null
      },
      *loadUser() {
        return null
      },
    }

    const outcome = await run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(JWTSessionAuth, { secret: 'test-secret-please-change' })
      yield* JWTSessionAuth.actions.provide(provider)
      return yield* JWTSessionAuth.actions.signIn({ username: 'nobody' })
    })

    expect(isSuccess(outcome)).toBe(false)
  })
})

describe('auth plugin (access + refresh)', () => {
  it('issues + rotates refresh tokens and revokes the old one', async () => {
    const store = new Map<string, AuthDef.RefreshRecord>()
    const provider: AuthDef.Provider = {
      *authenticate(credentials) {
        return (credentials as { username?: string }).username === 'mona' ? { id: 'u1' } : null
      },
      *loadUser(id) {
        return id === 'u1' ? { id: 'u1' } : null
      },
      *saveRefreshToken(record) {
        store.set(record.jti, record)
      },
      *findRefreshToken(jti) {
        return store.get(jti) ?? null
      },
      *revokeRefreshToken(jti) {
        const record = store.get(jti)
        if (record) {
          record.revokedAt = Date.now()
        }
      },
    }

    const outcome = await run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(AccessRefreshAuth, { secret: 'test-secret-please-change' })
      yield* AccessRefreshAuth.actions.provide(provider)

      const signedIn = yield* AccessRefreshAuth.actions.signIn({ username: 'mona' })
      const session = yield* AccessRefreshAuth.actions.authorize(signedIn.accessToken)
      const rotated = yield* AccessRefreshAuth.actions.refresh(signedIn.refreshToken)
      const rotatedSession = yield* AccessRefreshAuth.actions.authorize(rotated.accessToken)

      return {
        sub: session.sub,
        rotatedSub: rotatedSession.sub,
        firstRefresh: signedIn.refreshToken,
        rotatedRefresh: rotated.refreshToken,
        // rotation revoked exactly the original record and saved a fresh one
        revokedCount: [...store.values()].filter(record => record.revokedAt !== null).length,
      }
    })

    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(outcome.value.sub).toBe('u1')
      expect(outcome.value.rotatedSub).toBe('u1')
      expect(outcome.value.rotatedRefresh).not.toBe(outcome.value.firstRefresh)
      expect(outcome.value.revokedCount).toBe(1)
    }
  })
})
