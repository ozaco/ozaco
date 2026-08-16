/**
 * Real-node e2e smoke for @ozaco/server — imports the BUILT dist through the package's real
 * subpath exports (node package self-reference resolves them exactly like a consumer install).
 * Sequential runs cover:
 *
 * 1. node gateway adapter (node:http + the `ws` peer) on a dynamic port — HTTP action round trip
 *    and a websocket echo route via node's global fetch/WebSocket, then the worker carrier
 *    spawning a worker_threads child (smoke-node-child.mjs) for one dispatch + a streamed reply.
 * 2. idle lease, ping path — a SILENT client survives many TTLs because `ws.ping()` protocol
 *    pings are auto-ponged and renew the lease (exercises the adapter's ping/pong wiring).
 * 3. idle lease, reap path — with pings disabled a silent socket is closed 4000 'idle timeout'.
 *
 * Prints PASS/FAIL per check and exits non-zero on any failure. Run via scripts/test-node.sh
 * (moon task server:test-node).
 */
import {
  Broker,
  DefaultBroker,
  DefaultGateway,
  Gateway,
  defineAction,
  defineService,
} from '@ozaco/server'
import { NodeGatewayAdapter } from '@ozaco/server/gateway/node'
import { WorkerTransport } from '@ozaco/server/transport/worker'
import { collectFlow } from '@ozaco/server/utils'
import { run, until } from '@ozaco/std/effect'
import { NodeIO } from '@ozaco/std/io/impl/node'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { isFailure } from '@ozaco/std/result'

const childScript = new URL('smoke-node-child.mjs', import.meta.url)
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
      return { pong: true, runtime: 'node' }
    }),
  },
})

await scopedRun('gateway + worker run completed', function* () {
  yield* bootstrap()
  yield* Broker.actions.register(echoService)
  yield* install(NodeGatewayAdapter)
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
    res.status === 200 && body.pong === true && body.runtime === 'node',
    `status=${res.status} body=${JSON.stringify(body)}`,
  )

  const frames = yield* until(wsExchange(`ws://127.0.0.1:${info.port}/ws/echo`, ['ping'], 2))

  check('ws echo round trip', frames.join(',') === 'hello,echo:ping', frames.join(','))

  yield* install(WorkerTransport, { script: childScript, count: 1 })

  const sum = yield* Broker.actions.call('math', 'add', { a: 2, b: 3 })

  check('worker dispatch add', sum === 5, `sum=${String(sum)}`)

  const counted = yield* collectFlow(yield* Broker.actions.call('math', 'countTo'))

  check('worker streamed reply', counted.join(',') === '1,2,3', counted.join(','))
})

await scopedRun('idle ping run completed', function* () {
  yield* bootstrap()
  yield* install(NodeGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw', idle: { ttlMs: 250, pingMs: 60 } })
  yield* Gateway.actions.socket('/live', {
    *message() {},
  })

  const info = yield* Gateway.actions.start({ port: 0 })
  const outcome = yield* until(silentProbe(`ws://127.0.0.1:${info.port}/live`, 1000))

  check(
    'protocol pings keep a silent client alive',
    outcome.kind === 'alive',
    outcome.kind === 'alive' ? 'survived 4 TTLs' : `closed ${outcome.code} "${outcome.reason}"`,
  )
})

await scopedRun('idle reap run completed', function* () {
  yield* bootstrap()
  yield* install(NodeGatewayAdapter)
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
    ? `PASS node smoke (${checks.length} checks)`
    : `FAIL node smoke (${failed.length}/${checks.length} failed)`,
)
// no process.exit — a natural exit doubles as the teardown check (nothing may hold the loop open)
process.exitCode = failed.length === 0 ? 0 : 1
