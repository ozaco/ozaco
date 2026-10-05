import { attempt, run, scoped, sleep, withResolvers } from 'std:effect'
import type { IODef } from 'std:io'
import { IO } from 'std:io'
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
    const echo = function* (socket: IODef.TcpSocket) {
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
    }

    const outcome = await run(() =>
      scoped(function* () {
        yield* BunIO.use()

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
    const replyAndClose = function* (socket: IODef.TcpSocket) {
      const inbound = yield* socket.data
      const first = yield* inbound.next()

      if (!first.done) {
        yield* socket.write('bye')
      }

      yield* socket.close()
    }

    const outcome = await run(function* () {
      yield* BunIO.use()

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

  it('a peer FIN ends only `data`: the reply still goes out (printf x | nc)', async () => {
    // read everything the client sends, THEN answer — only possible if the socket stays writable
    const answerAfterEof = function* (socket: IODef.TcpSocket) {
      const inbound = yield* socket.data
      const bytes: number[] = []

      while (true) {
        const chunk = yield* inbound.next()

        if (chunk.done) {
          break
        }

        bytes.push(...chunk.value)
      }

      yield* socket.write(`got:${decoder.decode(Uint8Array.from(bytes))}`)
      yield* socket.end()
    }

    const outcome = await run(function* () {
      yield* BunIO.use()

      const server = yield* IO.actions.tcpListen({ port: 0 }, answerAfterEof)
      const client = yield* IO.actions.tcpConnect({ port: server.port })
      const received = yield* client.data

      yield* client.write('x')
      yield* client.end()
      // a second end is a no-op
      yield* client.end()

      const bytes: number[] = []
      let close: unknown = 'still-open'

      while (true) {
        const chunk = yield* received.next()

        if (chunk.done) {
          close = chunk.value

          break
        }

        bytes.push(...chunk.value)
      }

      // both sides ended: the socket is gone, and `closed` answers every waiter the same
      const closed = yield* client.closed
      const again = yield* client.closed

      yield* server.close()

      return { reply: decoder.decode(Uint8Array.from(bytes)), close, closed, again }
    })

    expect(unwrap(outcome)).toEqual({ reply: 'got:x', close: true, closed: true, again: true })
  })

  it('after `end()` the half-closed side still reads until the peer ends', async () => {
    const lateTalker = function* (socket: IODef.TcpSocket) {
      const inbound = yield* socket.data
      const first = yield* inbound.next()

      // the client already sent FIN: its data has ended, yet we can still talk to it
      yield* socket.write(first.done ? 'eof-first' : 'data-first')
      yield* sleep(5)
      yield* socket.write('-late')
      yield* socket.close()
    }

    const outcome = await run(function* () {
      yield* BunIO.use()

      const server = yield* IO.actions.tcpListen({ port: 0 }, lateTalker)
      const client = yield* IO.actions.tcpConnect({ port: server.port })
      const received = yield* client.data

      yield* client.end()

      const bytes: number[] = []

      while (true) {
        const chunk = yield* received.next()

        if (chunk.done) {
          break
        }

        bytes.push(...chunk.value)
      }

      const closed = yield* client.closed

      yield* server.close()

      return { heard: decoder.decode(Uint8Array.from(bytes)), closed }
    })

    expect(unwrap(outcome)).toEqual({ heard: 'eof-first-late', closed: true })
  })

  it('listens on and dials a unix socket path; the file goes with the server', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/std-net-${crypto.randomUUID().slice(0, 8)}.sock`
    const echo = function* (socket: IODef.TcpSocket) {
      const inbound = yield* socket.data
      const chunk = yield* inbound.next()

      if (!chunk.done) {
        yield* socket.write(chunk.value)
      }
    }

    const outcome = await run(function* () {
      yield* BunIO.use()

      const bound = yield* scoped(function* () {
        const server = yield* IO.actions.tcpListen({ path }, echo)
        const client = yield* IO.actions.tcpConnect({ path })
        const received = yield* client.data

        yield* client.write('over ipc')

        const chunk = yield* received.next()

        return {
          server: { port: server.port, hostname: server.hostname, path: server.path },
          heard: chunk.done ? '' : decoder.decode(chunk.value),
          file: yield* IO.actions.exists(path),
        }
      })

      return { ...bound, fileAfter: yield* IO.actions.exists(path) }
    })

    expect(unwrap(outcome)).toEqual({
      server: { port: 0, hostname: '', path },
      heard: 'over ipc',
      file: true,
      fileAfter: false,
    })
  })

  it('dialing a unix socket path nobody listens on fails with tcp-connect-failed', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const refused = yield* attempt(() =>
        IO.actions.tcpConnect({ path: `${process.env.TMPDIR ?? '/tmp'}/std-net-nobody.sock` }),
      )

      return isFailure(refused) ? [refused.error, refused.message] : 'no-failure'
    })

    expect(unwrap(outcome)).toEqual([
      'std:io.tcp-connect-failed',
      `tcp connect to ${process.env.TMPDIR ?? '/tmp'}/std-net-nobody.sock failed`,
    ])
  })

  it('connecting to a dead port fails with tcp-connect-failed', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const server = yield* IO.actions.tcpListen({ port: 0 }, function* () {})
      const deadPort = server.port

      yield* server.close()
      yield* sleep(20)

      const refused = yield* attempt(() => IO.actions.tcpConnect({ port: deadPort }))

      return isFailure(refused) ? refused.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('std:io.tcp-connect-failed')
  })

  // Regression pin: tcpListen (src/io/internal/net/sockets.ts) runs each connection handler via
  // `scope.run(...).finally(...)`; when the listening scope closes while a handler task is still
  // live, the task is halted and its promise RESOLVES the `halted` Failure (a task's promise side
  // never rejects), so the `finally` chain needs no `.catch` guard and shutdown leaks no unhandled
  // rejection. Verified with a `process.on('unhandledRejection')` probe when the guard was removed.
  it('closing a server scope with a still-connected client leaks no unhandled rejection', async () => {
    const accepted = withResolvers<void>()
    const parked = function* (socket: IODef.TcpSocket) {
      accepted.resolve()

      const inbound = yield* socket.data

      while (true) {
        const chunk = yield* inbound.next()

        if (chunk.done) {
          return
        }
      }
    }

    const outcome = await run(() =>
      scoped(function* () {
        yield* BunIO.use()

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

describe('endpoint notation', () => {
  it('parses tcp / ipc / inproc and formats them back; anything else is null', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const parsed = {
        tcp: yield* IO.actions.parseEndpoint('tcp://127.0.0.1:5555'),
        any: yield* IO.actions.parseEndpoint('tcp://*:0'),
        ipc: yield* IO.actions.parseEndpoint('ipc:///tmp/app.sock'),
        inproc: yield* IO.actions.parseEndpoint('inproc://hub'),
        bad: [
          yield* IO.actions.parseEndpoint('tcp://host'),
          yield* IO.actions.parseEndpoint('tcp://host:70000'),
          yield* IO.actions.parseEndpoint('udp://host:1'),
          yield* IO.actions.parseEndpoint('ipc://'),
          yield* IO.actions.parseEndpoint('nonsense'),
        ],
      }

      return {
        ...parsed,
        formatted: [
          yield* IO.actions.formatEndpoint({ scheme: 'tcp', host: '0.0.0.0', port: 5555 }),
          yield* IO.actions.formatEndpoint({ scheme: 'ipc', path: '/tmp/app.sock' }),
          yield* IO.actions.formatEndpoint({ scheme: 'inproc', name: 'hub' }),
        ],
      }
    })

    expect(unwrap(outcome)).toEqual({
      tcp: { scheme: 'tcp', host: '127.0.0.1', port: 5555 },
      any: { scheme: 'tcp', host: '0.0.0.0', port: 0 },
      ipc: { scheme: 'ipc', path: '/tmp/app.sock' },
      inproc: { scheme: 'inproc', name: 'hub' },
      bad: [null, null, null, null, null],
      formatted: ['tcp://0.0.0.0:5555', 'ipc:///tmp/app.sock', 'inproc://hub'],
    })
  })
})

describe('udp', () => {
  it('close is idempotent and the message flow closes with true exactly once read', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const socket = yield* IO.actions.udpBind()
      const messages = yield* socket.messages

      yield* socket.close()

      const second = yield* attempt(() => socket.close())
      const closing = yield* messages.next()

      return {
        second: isFailure(second) ? 'failed' : 'ok',
        close: closing.done === true ? closing.value : 'still-open',
      }
    })

    expect(unwrap(outcome)).toEqual({ second: 'ok', close: true })
  })

  it('the socket is IPv4-only: a send to an IPv6 destination fails udp-send-failed', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const socket = yield* IO.actions.udpBind({ hostname: '127.0.0.1' })
      const sent = yield* attempt(() => socket.send('x', socket.port, '::1'))

      yield* socket.close()

      return isFailure(sent) ? sent.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('std:io.udp-send-failed')
  })

  it('two sockets exchange a datagram; close ends the message flow', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const sender = yield* IO.actions.udpBind()
      const receiver = yield* IO.actions.udpBind()
      const messages = yield* receiver.messages

      yield* sender.send('hello udp', receiver.port, '127.0.0.1')

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
      text: 'hello udp',
      fromSender: true,
      address: '127.0.0.1',
      close: true,
    })
  })
})
