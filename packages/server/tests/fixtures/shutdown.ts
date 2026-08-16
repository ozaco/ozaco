import {
  Broker,
  DefaultBroker,
  DefaultGateway,
  defineAction,
  defineService,
  Gateway,
} from 'server:core'
import { run, scoped, sleep, until } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { BunGatewayAdapter } from 'server:gateway/bun'
import { CachePolicy } from 'server:policy/cache'
import { RetryPolicy } from 'server:policy/retry'
import { TimeoutPolicy } from 'server:policy/timeout'
import { BunIO } from 'std:io/impl/bun'
/**
 * Graceful-shutdown fixture: builds the full stack (broker + policies + gateway + a live request
 * + a websocket), closes every scope, and relies on the process exiting NATURALLY — any leaked
 * timer, socket or surviving forked pump hangs the process and fails the lifecycle test.
 */
import { z } from 'zod'

const service = defineService({
  name: 'shutdown-svc',
  actions: {
    ping: defineAction(
      { input: z.object({ n: z.coerce.number() }), route: { method: 'GET', path: '/ping' } },
      function* (body) {
        return { pong: body.n }
      },
    ),
  },
})

const outcome = await run(() =>
  scoped(function* () {
    yield* install(BunIO)
    yield* install(DefaultLogger, { level: LogLevel.silent })
    yield* install(DefaultBroker)
    yield* install(CachePolicy, {})
    yield* install(RetryPolicy, {})
    yield* install(TimeoutPolicy, {})
    yield* Broker.actions.start()
    yield* Broker.actions.register(service)
    yield* install(BunGatewayAdapter)
    yield* install(DefaultGateway)
    yield* Gateway.actions.mount('/svc', service)

    const info = yield* Gateway.actions.start({ port: 0 })

    // real traffic through the whole stack
    const res = yield* until(fetch(`${info.url}/svc/ping?n=7`))
    const body = (yield* until(res.json())) as { pong: number }

    if (body.pong !== 7) {
      throw new Error(`unexpected body: ${JSON.stringify(body)}`)
    }

    console.log('request-done')

    // a socket route with a live connection that the teardown must reap
    yield* Gateway.actions.socket('/live', {
      *message(socket, data) {
        socket.send(`echo:${String(data)}`)
      },
    })

    const socket = new WebSocket(`ws://127.0.0.1:${info.port}/live`)

    yield* until(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve())
        socket.addEventListener('error', () => reject(new Error('ws failed')))
      }),
    )

    console.log('socket-open')

    yield* Gateway.actions.stop()
    yield* Broker.actions.destroy()
    yield* sleep(10)

    console.log('stack-stopped')
  }),
)

unwrap(outcome)
console.log('all-done')
