import {
  Broker,
  CoreErrors,
  DefaultGateway,
  defineAction,
  defineService,
  Gateway,
} from 'server:core'
import { operation, until } from 'std:effect'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { BunGatewayAdapter } from 'server:gateway/bun'
import { JwtSessionAuth } from 'server:plugin/auth'

import { bootstrap } from '../core/helpers'
import { wsExchange } from '../gateway/helpers'
import { runScoped } from '../helpers'

import { createMemoryProvider, TEST_SECRET } from './helpers'

const secureService = () =>
  defineService({
    name: 'secure',
    actions: {
      secret: defineAction({ route: { method: 'GET', path: '/secret' } }, function* () {
        const principal = yield* JwtSessionAuth.actions.user()

        yield* JwtSessionAuth.actions.requirePermission(principal, 'todos:read')

        return { sub: principal.sub }
      }),
    },
  })

const boot = operation(function* () {
  yield* bootstrap()

  const { provider } = createMemoryProvider()

  yield* install(JwtSessionAuth, { secret: TEST_SECRET, provider })

  const service = secureService()

  yield* Broker.actions.register(service)
  yield* install(BunGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw' })
  yield* Gateway.actions.mount('/secure', service)

  return yield* Gateway.actions.start({ port: 0 })
})

/** Resolves true when the ws handshake is REJECTED (error before open). */
const wsRejected = (url: string): Promise<boolean> =>
  new Promise(resolve => {
    const socket = new WebSocket(url)
    let settled = false
    const settle = (outcome: boolean) => {
      if (!settled) {
        settled = true
        resolve(outcome)
      }
    }
    const timer = setTimeout(() => {
      socket.close()
      settle(false)
    }, 2000)

    socket.addEventListener('open', () => {
      clearTimeout(timer)
      socket.close()
      settle(false)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      settle(true)
    })
  })

describe('auth: edge e2e', () => {
  it('answers 401 without a token, 403 without the permission, 200 with both', async () => {
    const result = await runScoped(function* () {
      const info = yield* boot()

      const denied = yield* until(fetch(`${info.url}/secure/secret`))
      const deniedBody = (yield* until(denied.json())) as { error: string; requestId: string }

      const powerless = yield* JwtSessionAuth.actions.signIn({ username: 'u2', password: 'pw-2' })
      const forbidden = yield* until(
        fetch(`${info.url}/secure/secret`, {
          headers: { authorization: `Bearer ${powerless.token}` },
        }),
      )
      const forbiddenBody = (yield* until(forbidden.json())) as { error: string }

      const session = yield* JwtSessionAuth.actions.signIn({ username: 'u1', password: 'pw-1' })
      const allowed = yield* until(
        fetch(`${info.url}/secure/secret`, {
          headers: { authorization: `Bearer ${session.token}` },
        }),
      )
      const allowedBody = (yield* until(allowed.json())) as { sub: string }

      return {
        deniedStatus: denied.status,
        deniedBody,
        forbiddenStatus: forbidden.status,
        forbiddenBody,
        allowedStatus: allowed.status,
        allowedBody,
      }
    })

    expect(result.deniedStatus).toBe(401)
    expect(result.deniedBody.error).toBe(CoreErrors.Unauthorized)
    expect(result.deniedBody.requestId).toMatch(/^r_/u)
    expect(result.forbiddenStatus).toBe(403)
    expect(result.forbiddenBody.error).toBe(CoreErrors.Forbidden)
    expect(result.allowedStatus).toBe(200)
    expect(result.allowedBody.sub).toBe('u1')
  })

  it('guards ws routes: no token → 401 rejection, ?token= → accepted', async () => {
    const result = await runScoped(function* () {
      const info = yield* boot()

      yield* Gateway.actions.socket('/live', {
        authorize: yield* JwtSessionAuth.actions.authorizeSocket(),
        *message(socket, data) {
          socket.send(`echo:${String(data)}`)
        },
      })

      const session = yield* JwtSessionAuth.actions.signIn({ username: 'u1', password: 'pw-1' })
      const rejected = yield* until(wsRejected(`ws://127.0.0.1:${info.port}/live`))
      const accepted = yield* until(
        wsExchange(`ws://127.0.0.1:${info.port}/live?token=${session.token}`, ['hi'], 1),
      )

      return { rejected, accepted }
    })

    expect(result.rejected).toBe(true)
    expect(result.accepted).toEqual(['echo:hi'])
  })
})
