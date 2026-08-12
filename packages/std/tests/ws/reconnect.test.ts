import { run, scoped, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import { Ws } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { wsServer } from './helpers'

// Reconnect is BUILT IN: with `reconnect` configured, a server-initiated drop is redialed in the
// background and every socket generation feeds the same continuous `messages` flow. These tests
// pin that: flow continuity across generations, the `reconnects` counter, sends parking through a
// reconnect window, and the 'ws/reconnect-exhausted' failure close when the budget runs out.

const OPEN = 1

/** Drops the FIRST connection right after a greeting; echoes on every later connection. */
const dropFirstServer = () => {
  let connections = 0
  return wsServer({
    open(socket) {
      connections += 1
      if (connections === 1) {
        socket.send('welcome-then-drop')
        socket.close(4002, 'first-connection-dropped')
      }
    },
    message(socket, data) {
      socket.send(data)
    },
  })
}

/** Closes the current connection when told to (`drop-now`); echoes everything else. */
const dropOnCommandServer = () =>
  wsServer({
    message(socket, data) {
      if (String(data) === 'drop-now') {
        socket.close(4002, 'commanded-drop')
        return
      }
      socket.send(data)
    },
  })

/**
 * Upgrades exactly once (dropping that socket on open), then refuses every later upgrade.
 * Deliberately NOT the shared wsServer helper: refusing upgrades is the whole point.
 */
const dropThenRefuseServer = (code: number, reason: string) => {
  let upgrades = 0
  return Bun.serve({
    port: 0,
    fetch(request, srv) {
      upgrades += 1
      if (upgrades === 1 && srv.upgrade(request)) {
        return
      }
      return new Response('no more upgrades', { status: 400 })
    },
    websocket: {
      open(socket) {
        socket.close(code, reason)
      },
      message() {},
    },
  })
}

describe('automatic reconnect', () => {
  it('one continuous flow spans generations, and `reconnects` counts the reopen', async () => {
    const server = dropFirstServer()
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`, {
            reconnect: { retries: 5, delayMs: 10 },
          })
          const subscription = yield* connection.messages

          const greeting = yield* subscription.next() // generation 1's frame
          while (connection.reconnects === 0) {
            yield* sleep(5) // the drop is redialed in the background
          }

          yield* connection.send('hello-again')
          const echo = yield* subscription.next() // generation 2's frame, SAME subscription

          const snapshot = {
            greeting: greeting.value,
            echo: echo.value,
            reconnects: connection.reconnects,
          }
          yield* connection.close()

          return snapshot
        }),
      )

      expect(unwrap(outcome)).toEqual({
        greeting: 'welcome-then-drop',
        echo: 'hello-again',
        reconnects: 1,
      })
    } finally {
      server.stop(true)
    }
  })

  it('a send during the reconnect window parks, then goes out once the socket reopens', async () => {
    const server = dropOnCommandServer()
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`, {
            reconnect: { retries: 5, delayMs: 25 },
          })
          const subscription = yield* connection.messages

          yield* connection.send('drop-now')
          while (connection.readyState === OPEN) {
            yield* sleep(2) // wait until the drop lands; the redial is ≥25ms away
          }

          // socket is down, reconnect pending: this send must park until generation 2 is OPEN
          yield* connection.send('after-reopen')
          const echo = yield* subscription.next()

          const snapshot = { echo: echo.value, reconnects: connection.reconnects }
          yield* connection.close()

          return snapshot
        }),
      )

      expect(unwrap(outcome)).toEqual({ echo: 'after-reopen', reconnects: 1 })
    } finally {
      server.stop(true)
    }
  })

  it('exhausted retries close the flow with ws/reconnect-exhausted carrying the last close', async () => {
    const server = dropThenRefuseServer(4008, 'go-away')
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(JsonCodec)
          // install-time defaults: connect() below passes no options at all
          yield* install(Ws, { reconnect: { retries: 3, delayMs: 10, backoff: 2 } })

          const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
          const subscription = yield* connection.messages

          const end = yield* subscription.next() // blocks until the budget is exhausted
          const info = yield* connection.closed

          if (!end.done || !isFailure(end.value)) {
            return 'unexpected-flow-close'
          }

          return {
            tag: String(end.value.error),
            message: end.value.message,
            info,
            reconnects: connection.reconnects,
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({
        tag: 'ws/reconnect-exhausted',
        message: 'gave up after 3 redial attempts (last close: 4008 go-away)',
        info: { code: 4008, reason: 'go-away' },
        reconnects: 0,
      })
    } finally {
      server.stop(true)
    }
  })
})
