import { describe, expect, it } from 'bun:test'

import {
  Broker,
  CoreErrors,
  DefaultBroker,
  Gateway,
  defineAction,
  defineService,
  tagOf,
  useRequest,
} from '@ozaco/server/core'
import type { GatewayDef } from '@ozaco/server/core'
import { BunGateway } from '@ozaco/server/gateway/bun'
import { NodeGateway } from '@ozaco/server/gateway/node'
import { Cors } from '@ozaco/server/plugin/cors'
import { run, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { fail } from '@ozaco/std/result'

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

const api = defineService({
  name: 'api',
  version: '0.0.0',
  actions: {
    ping: defineAction(
      { settings: [Gateway.actions.rest({ method: 'GET', path: '/ping/:name' })] },
      function* (body) {
        const params = (body ?? {}) as { name?: string }
        return { pong: params.name ?? 'world' }
      },
    ),
    echo: defineAction(
      { settings: [Gateway.actions.rest({ method: 'POST', path: '/echo' })] },
      function* (body) {
        const req = yield* useRequest()
        return { seenMethod: req.method, body }
      },
    ),
    boom: defineAction(
      { settings: [Gateway.actions.rest({ method: 'GET', path: '/boom' })] },
      function* () {
        return yield* fail(CoreErrors.Forbidden, 'nope')
      },
    ),
    chat: defineAction({ settings: [Gateway.actions.ws({ path: '/chat' })] }, function* (body) {
      return { echoed: body }
    }),
  },
  *setup() {},
})

const startGateway = async (impl: GatewayDef.Default, port: number, withCors = false) => {
  const ready = Promise.withResolvers<void>()
  const task = run(function* () {
    yield* install(BunIO)
    yield* install(DefaultLogger, { level: LogLevel.silent })
    yield* install(DefaultBroker)
    yield* install(impl, { port })
    yield* api.actions.install()
    if (withCors) {
      yield* install(Cors, { origin: '*' })
    }
    yield* Broker.actions.register(api)
    yield* Gateway.actions.mount('', api)
    yield* Broker.actions.start()
    yield* Gateway.actions.start({ port })
    ready.resolve()
    yield* suspend()
  })
  await ready.promise
  await wait(50)
  return { task }
}

describe('gateway', () => {
  it.each([
    ['bun', BunGateway, 39_001],
    ['node', NodeGateway, 39_002],
  ])('REST routing + status mapping + context (%s)', async (_name, impl, port) => {
    const { task } = await startGateway(impl, port)
    try {
      const base = `http://localhost:${port}`

      const ping = await fetch(`${base}/ping/Mona`)
      expect(ping.status).toBe(200)
      expect(await ping.json()).toEqual({ pong: 'Mona' })

      const echo = await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 1 }),
      })
      expect(echo.status).toBe(200)
      expect(await echo.json()).toEqual({ seenMethod: 'POST', body: { x: 1 } })

      const boom = await fetch(`${base}/boom`)
      expect(boom.status).toBe(403)
      const boomBody = await boom.json()
      expect(tagOf(boomBody.error)).toBe(CoreErrors.Forbidden)

      const missing = await fetch(`${base}/nope`)
      expect(missing.status).toBe(404)
    } finally {
      await task.halt()
    }
  })

  it('route-bound WebSocket echoes a frame through the action (bun)', async () => {
    const port = 39_003
    const { task } = await startGateway(BunGateway, port)
    try {
      const reply = await new Promise<unknown>((resolve, reject) => {
        const socket = new WebSocket(`ws://localhost:${port}/chat`)
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ hi: 'there' }))
        })
        socket.addEventListener('message', event => {
          resolve(JSON.parse(String(event.data)))
          socket.close()
        })
        socket.addEventListener('error', () => reject(new Error('websocket error')))
      })
      expect(reply).toEqual({ echoed: { hi: 'there' } })
    } finally {
      await task.halt()
    }
  })

  it('CORS plugin sets headers + answers preflight (bun)', async () => {
    const port = 39_004
    const { task } = await startGateway(BunGateway, port, true)
    try {
      const base = `http://localhost:${port}`

      const preflight = await fetch(`${base}/ping/x`, {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

      const ping = await fetch(`${base}/ping/x`, { headers: { origin: 'https://app.example' } })
      expect(ping.headers.get('access-control-allow-origin')).toBe('*')
    } finally {
      await task.halt()
    }
  })
})
