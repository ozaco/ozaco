import { Broker, DefaultBroker } from 'server:core'
import { main, suspend } from 'std:effect'
import { install } from 'std:plugin'

import { WorkerTransport } from 'server:transport/worker'
import { BunIO } from 'std:io/impl/bun'

import { ComputeService } from './service'

/**
 * Worker-side entry (runs inside each spawned worker). One broker that hosts `ComputeService` and
 * bridges back to the spawning thread: `WorkerTransport` with no `script`/`endpoint` attaches to the
 * parent (`self` / node `parentPort`). It stays alive (`suspend`) serving dispatches until the host
 * terminates the worker on shutdown.
 *
 * NOTE: `main` is NOT awaited. The body never returns (`suspend`), and a pending top-level `await`
 * blocks a worker's incoming `message` delivery in Bun — so the run loop is left to keep the worker
 * alive while its message listener stays live.
 */
void main(function* () {
  yield* install(BunIO)
  yield* install(DefaultBroker)

  yield* install(ComputeService)
  yield* Broker.actions.register(ComputeService)

  yield* install(WorkerTransport)
  yield* Broker.actions.start()

  yield* suspend()
})
