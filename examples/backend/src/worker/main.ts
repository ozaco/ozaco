import { Broker, DefaultBroker } from 'server:core'
import { each, ensure, main } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { WorkerTransport } from 'server:transport/worker'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

import { ComputeService } from './service'

/**
 * Host-side entry. Spawn a pool of workers (each runs `./entry` and hosts `ComputeService`) and
 * dispatch to it through the broker. `ComputeService` is deliberately NOT registered here, so the
 * local `InternalTransport` returns NotFound and each call falls through to the worker transport,
 * which round-robins it across the pool. Run after a build:
 *
 *   moon run backend:build
 *   bun examples/backend/dist/worker/main.js
 */
await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.info })
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker)

  // priority below the broker's local InternalTransport (0) so `compute` calls — which this thread
  // does not host — are routed to the worker pool. The transport round-robins them across the workers.
  yield* install(WorkerTransport, {
    script: new URL('entry.js', import.meta.url),
    count: 4,
    priority: -1,
    wire: 'codec',
  })
  yield* Broker.actions.start()

  yield* ensure(function* () {
    yield* Logger.actions.info('Shutting down worker pool')
    yield* Broker.actions.destroy()
  })

  yield* Logger.actions.info('Dispatching fib() across 4 workers')
  for (const n of [32, 33, 34, 35]) {
    const out = yield* Broker.actions.call(ComputeService.actions.fib, [n])
    yield* Logger.actions.info(`  fib(${n}) -> ${JSON.stringify(out)}`)
  }

  // a streamed result, served from a worker over the same port
  const items: unknown[] = []
  const channel = yield* Broker.actions.call(ComputeService.actions.range, [5])
  for (const item of yield* each(channel as AnyType)) {
    items.push(item)
    yield* each.next()
  }
  yield* Logger.actions.info(`range(5) -> ${JSON.stringify(items)}`)
})
