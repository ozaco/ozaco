import { attempt, operation, run, scoped, sleep, withResolvers } from 'std:effect'
import type { TcpSocket } from 'std:io'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('tcp', () => {
  it('listen on port 0, connect, and echo a payload back', async () => {
    // Resolved when the handler unwinds naturally: a handler still parked at scope teardown is
    // halted, and its scope.run promise rejection is unhandled (see the todo below).
    const handlerFinished = withResolvers<void>()
    const echo = operation(function* (socket: TcpSocket) {
      try {
        const inbound = yield* socket.data
        while (true) {
          const chunk = yield* inbound.next()
          if (chunk.done) {
            return
          }
          yield* socket.write(chunk.value)
        }
      } finally {
        handlerFinished.resolve()
      }
    })

    const outcome = await run(() =>
      scoped(function* () {
        yield* install(BunIO)

        const server = yield* IO.actions.tcpListen({ port: 0 }, echo)

        const client = yield* IO.actions.tcpConnect({ port: server.port })
        const received = yield* client.data

        yield* client.write('ping')

        const payload = encoder.encode('ping')
        const bytes: number[] = []
        while (bytes.length < payload.length) {
          const chunk = yield* received.next()
          if (chunk.done) {
            break
          }
          bytes.push(...chunk.value)
        }

        // close our side, then drain to the flow's end — the close value must be checked
        yield* client.close()
        let close: unknown = 'still-open'
        while (true) {
          const trailing = yield* received.next()
          if (trailing.done) {
            close = trailing.value
            break
          }
        }

        // one timer tick after the signal: the resolve fires inside the handler's finally, so its
        // task is still unwinding — teardown reaching it before it settles would halt it and leak
        // an unhandled rejection through scope.run's promise (see the todo below)
        yield* handlerFinished.operation
        yield* sleep(1)
        yield* server.close()

        return {
          portAssigned: server.port > 0,
          echoed: decoder.decode(Uint8Array.from(bytes)),
          remotePort: client.remotePort === server.port,
          close,
        }
      }),
    )

    expect(unwrap(outcome)).toEqual({
      portAssigned: true,
      echoed: 'ping',
      remotePort: true,
      close: true,
    })
  })

  it('a server-side close ends the client data flow with a clean close value', async () => {
    const replyAndClose = operation(function* (socket: TcpSocket) {
      const inbound = yield* socket.data
      const first = yield* inbound.next()
      if (!first.done) {
        yield* socket.write('bye')
      }
      yield* socket.close()
    })

    const outcome = await run(function* () {
      yield* install(BunIO)

      const server = yield* IO.actions.tcpListen({ port: 0 }, replyAndClose)

      const client = yield* IO.actions.tcpConnect({ port: server.port })
      const received = yield* client.data

      yield* client.write('hello?')

      const reply = yield* received.next()
      const closing = yield* received.next()

      yield* server.close()

      return {
        reply: reply.done === true ? 'ended-early' : decoder.decode(reply.value),
        close: closing.done === true ? closing.value : 'still-open',
      }
    })

    expect(unwrap(outcome)).toEqual({ reply: 'bye', close: true })
  })

  it('connecting to a dead port fails with tcp-connect-failed', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const server = yield* IO.actions.tcpListen({ port: 0 }, function* () {})
      const deadPort = server.port
      yield* server.close()
      yield* sleep(20)

      const refused = yield* attempt(() => IO.actions.tcpConnect({ port: deadPort }))
      return isFailure(refused) ? refused.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('tcp-connect-failed')
  })

  // src bug: tcpListen (src/io/internal/net.ts) runs each connection handler via
  // `void scope.run(...).finally(...)`; when the listening scope closes while a handler task has
  // not fully settled (a live connection, or even a handler caught mid-unwind), the task is
  // halted and the scope.run promise — materialized by that .finally — rejects with a `halted`
  // Failure that nothing catches. The unhandled rejection fails the surrounding test run.
  // Pin the intended behavior once fixed:
  it('closing a server scope with a still-connected client leaks no unhandled rejection', async () => {
    const accepted = withResolvers<void>()
    const parked = operation(function* (socket: TcpSocket) {
      accepted.resolve()
      const inbound = yield* socket.data
      while (true) {
        const chunk = yield* inbound.next()
        if (chunk.done) {
          return
        }
      }
    })

    const outcome = await run(() =>
      scoped(function* () {
        yield* install(BunIO)

        const server = yield* IO.actions.tcpListen({ port: 0 }, parked)
        yield* IO.actions.tcpConnect({ port: server.port })

        // the handler is live and parked on `next()` when this scope closes — the halt it takes
        // during teardown must be absorbed by tcpListen, not leak through scope.run's promise
        yield* accepted.operation
      }),
    )

    expect(unwrap(outcome)).toBeUndefined()
    // an unabsorbed halt rejection surfaces on a later tick — give it the chance to fail the run
    await new Promise<void>(resolve => {
      setTimeout(resolve, 20)
    })
  })
})

describe('udp', () => {
  it('two sockets exchange a datagram; close ends the message flow', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const sender = yield* IO.actions.udpBind()
      const receiver = yield* IO.actions.udpBind()
      const messages = yield* receiver.messages

      yield* sender.send('merhaba udp', receiver.port, '127.0.0.1')

      const first = yield* messages.next()
      const datagram = first.done === true ? undefined : first.value

      yield* receiver.close()
      const closing = yield* messages.next()
      yield* sender.close()

      return {
        text: datagram === undefined ? 'ended-early' : decoder.decode(datagram.data),
        fromSender: datagram?.port === sender.port,
        address: datagram?.address,
        close: closing.done === true ? closing.value : 'still-open',
      }
    })

    expect(unwrap(outcome)).toEqual({
      text: 'merhaba udp',
      fromSender: true,
      address: '127.0.0.1',
      close: true,
    })
  })
})
