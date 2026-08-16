import { Broker, DefaultGateway, defineAction, defineService, Gateway } from 'server:core'
import { operation, until } from 'std:effect'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { BunGatewayAdapter } from 'server:gateway/bun'
import { Cors } from 'server:plugin/cors'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const fixture = () =>
  defineService({
    name: 'todos',
    actions: {
      list: defineAction({ route: { method: 'GET', path: '/' } }, function* () {
        return { items: ['a'] }
      }),
    },
  })

const boot = operation(function* (cors: boolean) {
  yield* bootstrap()

  const todos = fixture()

  yield* Broker.actions.register(todos)
  yield* install(BunGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw' })

  if (cors) {
    yield* install(Cors, { origins: ['http://a.test'], credentials: true })
  }

  yield* Gateway.actions.mount('/todos', todos)

  return yield* Gateway.actions.start({ port: 0 })
})

describe('plugin: cors', () => {
  it('echoes allowed origins with credentials, vary and exposed headers', async () => {
    const result = await runScoped(function* () {
      const info = yield* boot(true)

      const allowed = yield* until(
        fetch(`${info.url}/todos`, { headers: { origin: 'http://a.test' } }),
      )
      const denied = yield* until(
        fetch(`${info.url}/todos`, { headers: { origin: 'http://b.test' } }),
      )

      return {
        allowedStatus: allowed.status,
        origin: allowed.headers.get('access-control-allow-origin'),
        vary: allowed.headers.get('vary'),
        credentials: allowed.headers.get('access-control-allow-credentials'),
        expose: allowed.headers.get('access-control-expose-headers'),
        deniedStatus: denied.status,
        deniedOrigin: denied.headers.get('access-control-allow-origin'),
      }
    })

    expect(result.allowedStatus).toBe(200)
    expect(result.origin).toBe('http://a.test')
    expect(result.vary).toContain('origin')
    expect(result.credentials).toBe('true')
    expect(result.expose).toContain('x-request-id')
    expect(result.deniedStatus).toBe(200)
    expect(result.deniedOrigin).toBeNull()
  })

  it('answers preflights on routed AND unknown paths; disallowed origins fall through', async () => {
    const result = await runScoped(function* () {
      const info = yield* boot(true)
      const preflight = (path: string, origin: string) =>
        until(
          fetch(`${info.url}${path}`, {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'GET' },
          }),
        )

      const routed = yield* preflight('/todos', 'http://a.test')
      const unknown = yield* preflight('/nowhere', 'http://a.test')
      const denied = yield* preflight('/todos', 'http://b.test')

      return {
        routedStatus: routed.status,
        methods: routed.headers.get('access-control-allow-methods'),
        headers: routed.headers.get('access-control-allow-headers'),
        maxAge: routed.headers.get('access-control-max-age'),
        origin: routed.headers.get('access-control-allow-origin'),
        unknownStatus: unknown.status,
        deniedStatus: denied.status,
        deniedOrigin: denied.headers.get('access-control-allow-origin'),
      }
    })

    expect(result.routedStatus).toBe(204)
    expect(result.origin).toBe('http://a.test')
    expect(result.methods).toContain('GET')
    expect(result.methods).toContain('OPTIONS')
    expect(result.headers).toContain('authorization')
    expect(result.maxAge).toBe('600')
    expect(result.unknownStatus).toBe(204)
    expect(result.deniedStatus).toBe(404)
    expect(result.deniedOrigin).toBeNull()
  })

  it('without Cors an unknown-path OPTIONS is a plain 404', async () => {
    const result = await runScoped(function* () {
      const info = yield* boot(false)
      const response = yield* until(
        fetch(`${info.url}/nowhere`, {
          method: 'OPTIONS',
          headers: { origin: 'http://a.test', 'access-control-request-method': 'GET' },
        }),
      )

      return {
        status: response.status,
        origin: response.headers.get('access-control-allow-origin'),
      }
    })

    expect(result.status).toBe(404)
    expect(result.origin).toBeNull()
  })
})
