import { attempt, run } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { WsDef } from 'std:ws'
import { Ws, WsClient } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { echoServer } from './helpers'

describe('Ws.actions.connect', () => {
  it('resolves once the socket is OPEN, exposing url, readyState, and reconnects', async () => {
    const server = echoServer()
    try {
      const url = `ws://localhost:${server.port}`

      const outcome = await run(function* () {
        yield* JsonCodec.use()
        yield* WsClient.use()

        const connection = yield* Ws.actions.connect(url)
        const snapshot = {
          url: connection.url,
          readyState: connection.readyState,
          reconnects: connection.reconnects,
        }
        yield* connection.close()

        return snapshot
      })

      expect(unwrap(outcome)).toEqual({ url, readyState: 1, reconnects: 0 })
    } finally {
      server.stop(true)
    }
  })

  it('a refused connection surfaces as a ws/connect failure', async () => {
    // grab an ephemeral port, then free it — nothing listens there anymore
    const server = echoServer()
    const deadPort = server.port
    await server.stop(true)

    const outcome = await run(function* () {
      yield* WsClient.use()
      const result = yield* attempt(() => Ws.actions.connect(`ws://localhost:${deadPort}`))

      return isFailure(result) ? String(result.error) : 'connected'
    })

    expect(unwrap(outcome)).toBe('std:ws.connect')
  })

  it('a failed upgrade (plain HTTP response) surfaces as a ws/connect failure', async () => {
    // deliberately NOT the shared wsServer helper: this server must never upgrade
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('no websocket here', { status: 400 })
      },
    })
    try {
      const outcome = await run(function* () {
        yield* WsClient.use()
        const result = yield* attempt(() => Ws.actions.connect(`ws://localhost:${server.port}`))

        return isFailure(result) ? String(result.error) : 'connected'
      })

      expect(unwrap(outcome)).toBe('std:ws.connect')
    } finally {
      server.stop(true)
    }
  })

  it('a missing WebSocket implementation fails with ws/unsupported', async () => {
    const outcome = await run(function* () {
      yield* WsClient.use()
      // simulate a platform without a WebSocket global (`?? default` swallows undefined, so use false)
      yield* WsClient.use({ impl: false as unknown as WsDef.ImplLike })
      const result = yield* attempt(() => Ws.actions.connect('ws://localhost:1'))

      return isFailure(result) ? String(result.error) : 'connected'
    })

    expect(unwrap(outcome)).toBe('std:ws.unsupported')
  })

  it('connect without installing the plugin fails with missing-action', async () => {
    const outcome = await run(function* () {
      const result = yield* attempt(() => Ws.actions.connect('ws://localhost:1'))

      return isFailure(result) ? String(result.error) : 'connected'
    })

    expect(unwrap(outcome)).toBe('std:plugin.missing-action')
  })
})
