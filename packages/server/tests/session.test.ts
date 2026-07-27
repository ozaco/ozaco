import { describe, expect, it } from 'bun:test'

import type { GatewayDef } from '@ozaco/server/core'
import { Broker, defineSocket, DefaultBroker, Gateway } from '@ozaco/server/core'
import { BunGateway } from '@ozaco/server/gateway/bun'
import { operation, run, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import type { AnyType } from '@ozaco/std/shared'

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms)
  })

// a socket-only service: one `session` dispatch per connection, handlers routed by `event`
const echo = defineSocket(
  { name: 'echo-socket', path: '/echo' },
  {
    on: {
      hello: operation(function* (socket: GatewayDef.Socket, message: AnyType) {
        yield* socket.join('lobby')
        yield* socket.send({ reply: `hi ${String(message.name ?? '')}` })
      }),
      shout: operation(function* (socket: GatewayDef.Socket, message: AnyType) {
        yield* socket.toRoom('lobby', { room: 'lobby', said: message.text })
      }),
    },
    message: operation(function* (socket: GatewayDef.Socket, message: unknown) {
      yield* socket.send({ echoed: message })
    }),
  },
)

describe('session-mode sockets', () => {
  it('routes a whole connection through one dispatch (echo, rooms, control frames)', async () => {
    const port = 39_310
    const ready = Promise.withResolvers<void>()
    const task = run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(BunGateway, { port })
      yield* echo.actions.install()
      yield* Broker.actions.register(echo)
      yield* Gateway.actions.mount('/ws', echo)
      yield* Broker.actions.start()
      yield* Gateway.actions.start({ port })
      ready.resolve()
      yield* suspend()
    })
    await ready.promise
    await wait(50)

    const frames: AnyType[] = []
    const ws = new WebSocket(`ws://localhost:${port}/ws/echo`)
    ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
    await new Promise(resolve => {
      ws.addEventListener('open', resolve, { once: true })
    })

    ws.send(JSON.stringify({ event: 'hello', name: 'ozaco' }))
    await wait(150)
    // `join` rode the outbound stream as a control frame — applied by the gateway, never delivered
    expect(frames).toEqual([{ reply: 'hi ozaco' }])

    // the room registry now holds this socket, so a toRoom from the session reaches it
    ws.send(JSON.stringify({ event: 'shout', text: 'hey' }))
    await wait(150)
    expect(frames[1]).toEqual({ room: 'lobby', said: 'hey' })

    // unknown events fall through to the raw `message` catch-all
    ws.send(JSON.stringify({ ping: 1 }))
    await wait(150)
    expect(frames[2]).toEqual({ echoed: { ping: 1 } })

    ws.close()
    await wait(50)
    await task.halt()
  })
})
