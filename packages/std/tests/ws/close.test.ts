import { attempt, run, scoped, sleep, until } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import { Ws } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { echoServer, wsServer } from './helpers'

/** Pushes `frames` and then closes with the given code/reason as soon as the socket opens. */
const closingServer = (code: number, reason: string, frames: string[] = []) =>
  wsServer({
    open(socket) {
      for (const frame of frames) {
        socket.send(frame)
      }
      socket.close(code, reason)
    },
    message() {},
  })

describe('client-side close', () => {
  it('close() resolves once fully closed; the messages flow ends with `true`', async () => {
    const server = echoServer()
    try {
      const outcome = await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        const subscription = yield* connection.messages

        yield* connection.close(1000, 'client-done')

        const info = yield* connection.closed
        const done = yield* subscription.next()

        return {
          readyState: connection.readyState,
          code: info.code,
          flowClose: done.done ? done.value : 'not-done',
        }
      })

      expect(unwrap(outcome)).toEqual({ readyState: 3, code: 1000, flowClose: true })
    } finally {
      server.stop(true)
    }
  })

  it('send after close is a silent no-op', async () => {
    const server = echoServer()
    try {
      const outcome = await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        yield* connection.close()

        const late = yield* attempt(() => connection.send('too late'))

        return isFailure(late) ? String(late.error) : 'dropped-silently'
      })

      expect(unwrap(outcome)).toBe('dropped-silently')
    } finally {
      server.stop(true)
    }
  })
})

describe('server-initiated close (no reconnect configured)', () => {
  it('delivers pending frames, then the flow closes `true` and `closed` carries code/reason', async () => {
    const server = closingServer(4001, 'server-bye', ['last words'])
    try {
      const outcome = await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        const subscription = yield* connection.messages

        const first = yield* subscription.next()
        const done = yield* subscription.next()
        const info = yield* connection.closed

        return {
          first: first.value,
          flowClose: done.done ? done.value : 'not-done',
          info,
        }
      })

      expect(unwrap(outcome)).toEqual({
        first: 'last words',
        flowClose: true,
        info: { code: 4001, reason: 'server-bye' },
      })
    } finally {
      server.stop(true)
    }
  })

  it('close() on an already-closed socket resolves immediately', async () => {
    const server = closingServer(1000, 'early')
    try {
      const outcome = await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        const info = yield* connection.closed

        // socket is CLOSED by now — close() must not hang waiting for a second close event
        yield* connection.close()

        return { readyState: connection.readyState, reason: info.reason }
      })

      expect(unwrap(outcome)).toEqual({ readyState: 3, reason: 'early' })
    } finally {
      server.stop(true)
    }
  })
})

describe('scope teardown', () => {
  it('closing the scope closes the socket — the server observes it, no manual close', async () => {
    // the code only: Bun's server does not surface a client-sent close reason
    let observedCode: number | undefined
    let signalClosed = () => {}
    const serverSawClose = new Promise<void>(resolve => {
      signalClosed = resolve
    })

    const server = wsServer({
      message() {},
      close(_socket, code) {
        observedCode = code
        signalClosed()
      },
    })
    try {
      const outcome = await run(function* () {
        yield* scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          yield* Ws.actions.connect(`ws://localhost:${server.port}`)
          // NO close() here: leaving the scope must tear the connection down
        })

        yield* until(serverSawClose)
        return observedCode
      })

      expect(unwrap(outcome)).toBe(1000)
    } finally {
      server.stop(true)
    }
  })

  it('teardown never reconnects, even when reconnect is configured', async () => {
    let connections = 0
    let signalClosed = () => {}
    const serverSawClose = new Promise<void>(resolve => {
      signalClosed = resolve
    })

    const server = wsServer({
      open() {
        connections += 1
      },
      message() {},
      close() {
        signalClosed()
      },
    })
    try {
      const outcome = await run(function* () {
        yield* scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          yield* Ws.actions.connect(`ws://localhost:${server.port}`, {
            reconnect: { retries: 3, delayMs: 10 },
          })
        })

        yield* until(serverSawClose)
        // give a spurious redial (delayMs 10) ample time to show up — it must not
        yield* sleep(60)
        return connections
      })

      expect(unwrap(outcome)).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})
