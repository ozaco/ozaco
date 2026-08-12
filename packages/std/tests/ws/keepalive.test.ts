import { run, scoped, until } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import { Ws } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { wsServer } from './helpers'

/** An echo-less server that records every incoming frame and resolves a gate at `count` frames. */
const recordingServer = (count: number) => {
  const received: string[] = []
  let signal = () => {}
  const gate = new Promise<void>(resolve => {
    signal = resolve
  })
  const server = wsServer({
    message(_socket, data) {
      received.push(String(data))
      if (received.length >= count) {
        signal()
      }
    },
  })
  return { server, received, gate }
}

describe('keepalive', () => {
  it('sends the default payload at the configured interval while OPEN', async () => {
    const { server, received, gate } = recordingServer(2)
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`, {
            keepalive: { intervalMs: 20 },
          })

          yield* until(gate) // the server observed two keepalive frames
          yield* connection.close()

          return received.slice(0, 2)
        }),
      )

      expect(unwrap(outcome)).toEqual(['ping', 'ping'])
    } finally {
      server.stop(true)
    }
  })

  it('frames a structured payload through the registered codec', async () => {
    const { server, received, gate } = recordingServer(2)
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`, {
            keepalive: { intervalMs: 20, payload: { type: 'ping' } },
          })

          yield* until(gate)
          yield* connection.close()

          return received.slice(0, 2)
        }),
      )

      expect(unwrap(outcome)).toEqual(['{"type":"ping"}', '{"type":"ping"}'])
    } finally {
      server.stop(true)
    }
  })
})
