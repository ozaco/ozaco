import { attempt, run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { WsDef } from 'std:ws'
import { Ws, wsImpl } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { echoServer } from './helpers'

describe('Ws.actions.connect', () => {
  it('resolves once the socket is OPEN, exposing url, readyState, and reconnects', async () => {
    const server = echoServer()
    try {
      const url = `ws://localhost:${server.port}`

      const outcome = await run(() =>
        scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          const connection = yield* Ws.actions.connect(url)
          const snapshot = {
            url: connection.url,
            readyState: connection.readyState,
            reconnects: connection.reconnects,
          }
          yield* connection.close()

          return snapshot
        }),
      )

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

    const outcome = await run(() =>
      scoped(function* () {
        yield* install(Ws)
        const result = yield* attempt(() => Ws.actions.connect(`ws://localhost:${deadPort}`))

        return isFailure(result) ? String(result.error) : 'connected'
      }),
    )

    expect(unwrap(outcome)).toBe('ws/connect')
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
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(Ws)
          const result = yield* attempt(() => Ws.actions.connect(`ws://localhost:${server.port}`))

          return isFailure(result) ? String(result.error) : 'connected'
        }),
      )

      expect(unwrap(outcome)).toBe('ws/connect')
    } finally {
      server.stop(true)
    }
  })

  it('a missing WebSocket implementation fails with ws/unsupported', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* install(Ws)
        // simulate a platform without a WebSocket global (`?? default` swallows undefined, so use false)
        yield* wsImpl.set(false as unknown as WsDef.Ctor)
        const result = yield* attempt(() => Ws.actions.connect('ws://localhost:1'))

        return isFailure(result) ? String(result.error) : 'connected'
      }),
    )

    expect(unwrap(outcome)).toBe('ws/unsupported')
  })

  it('connect without installing the plugin fails with missing-action', async () => {
    const outcome = await run(function* () {
      const result = yield* attempt(() => Ws.actions.connect('ws://localhost:1'))

      return isFailure(result) ? String(result.error) : 'connected'
    })

    expect(unwrap(outcome)).toBe('missing-action')
  })
})
