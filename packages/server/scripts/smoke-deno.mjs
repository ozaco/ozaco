/**
 * Real-deno e2e smoke for @ozaco/server — imports the BUILT dist through the package's real
 * subpath exports (deno's node_modules resolution). Sequential scoped runs cover:
 *
 * 1. deno gateway adapter with the REAL `Deno.serve` + `Deno.upgradeWebSocket` (the default
 *    `denoImpl`) on a dynamic port — HTTP action round trip and a websocket echo route via deno's
 *    global fetch/WebSocket.
 * 2. idle lease, reap path — with pings disabled a silent socket is closed 4000 'idle timeout'
 *    (the deno adapter exposes no protocol ping, so the reap path is the one that applies here).
 *
 * Prints PASS/FAIL per check and exits non-zero on any failure. Run via scripts/test-deno.sh
 * (moon task server:test-deno).
 */
import {
  Broker,
  DefaultBroker,
  DefaultGateway,
  Gateway,
  defineAction,
  defineService,
} from '@ozaco/server'
import { DenoGatewayAdapter } from '@ozaco/server/gateway/deno'
import { run, until } from '@ozaco/std/effect'
import { NodeIO } from '@ozaco/std/io/impl/node'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { isFailure } from '@ozaco/std/result'

const checks = []

const check = (name, ok, detail) => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Await a effect run; a failed outcome records a FAIL check instead of throwing. */
const scopedRun = async (label, body) => {
  const outcome = await run(body)

  if (isFailure(outcome)) {
    check(label, false, `${String(outcome.error)}: ${outcome.message}`)
  }
}

const wsExchange = (url, sends, expected) =>
  new Promise((resolve, reject) => {
    const received = []
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`ws timeout — got ${received.length}/${expected}: ${received.join(',')}`))
    }, 3000)

    socket.addEventListener('open', () => {
      for (const message of sends) {
        socket.send(message)
      }
    })
    socket.addEventListener('message', event => {
      received.push(String(event.data))

      if (received.length >= expected) {
        clearTimeout(timer)
        socket.close()
        resolve(received)
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('ws error'))
    })
  })

/** Open a websocket and report its close (or `alive` after `aliveMs` of silence). */
const silentProbe = (url, aliveMs) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url)

    socket.addEventListener('close', event => {
      resolve({ kind: 'closed', code: event.code, reason: event.reason })
    })
    socket.addEventListener('error', () => {
      reject(new Error('probe failed to connect'))
    })
    socket.addEventListener('open', () => {
      setTimeout(() => {
        resolve({ kind: 'alive' })
        socket.close()
      }, aliveMs)
    })
  })

const bootstrap = function* () {
  yield* install(NodeIO)
  yield* install(DefaultLogger, { level: LogLevel.silent })
  yield* install(DefaultBroker)
  yield* Broker.actions.start()
}

const echoService = defineService({
  name: 'echo',
  version: '1.0.0',
  actions: {
    ping: defineAction({ route: { method: 'GET', path: '/ping' } }, function* () {
      return { pong: true, runtime: 'deno' }
    }),
  },
})

await scopedRun('gateway run completed', function* () {
  yield* bootstrap()
  yield* Broker.actions.register(echoService)
  yield* install(DenoGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw' })
  yield* Gateway.actions.mount('/echo', echoService)
  yield* Gateway.actions.socket('/ws/echo', {
    *open(socket) {
      socket.send('hello')
    },
    *message(socket, data) {
      socket.send(`echo:${String(data)}`)
    },
  })

  const info = yield* Gateway.actions.start({ port: 0 })

  const res = yield* until(fetch(`${info.url}/echo/ping`))
  const body = yield* until(res.json())

  check(
    'http action round trip',
    res.status === 200 && body.pong === true && body.runtime === 'deno',
    `status=${res.status} body=${JSON.stringify(body)}`,
  )

  const frames = yield* until(wsExchange(`ws://127.0.0.1:${info.port}/ws/echo`, ['ping'], 2))

  check('ws echo round trip', frames.join(',') === 'hello,echo:ping', frames.join(','))
})

await scopedRun('idle reap run completed', function* () {
  yield* bootstrap()
  yield* install(DenoGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw', idle: { ttlMs: 150, pingMs: 0 } })
  yield* Gateway.actions.socket('/live', {
    *message() {},
  })

  const info = yield* Gateway.actions.start({ port: 0 })
  const outcome = yield* until(silentProbe(`ws://127.0.0.1:${info.port}/live`, 3000))

  check(
    'silent socket reaped with 4000 "idle timeout"',
    outcome.kind === 'closed' && outcome.code === 4000 && outcome.reason === 'idle timeout',
    outcome.kind === 'closed' ? `closed ${outcome.code} "${outcome.reason}"` : 'never closed',
  )
})

const failed = checks.filter(entry => !entry.ok)

console.log(
  failed.length === 0
    ? `PASS deno smoke (${checks.length} checks)`
    : `FAIL deno smoke (${failed.length}/${checks.length} failed)`,
)
// no Deno.exit — a natural exit doubles as the teardown check (nothing may hold the loop open)
Deno.exitCode = failed.length === 0 ? 0 : 1
