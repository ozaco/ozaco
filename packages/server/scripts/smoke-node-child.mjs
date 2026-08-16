/**
 * Worker child entry for the real-node smoke — loaded by `new worker_threads.Worker(...)` from
 * smoke-node.mjs. Boots a full broker node inside the worker thread from the BUILT dist: NodeIO +
 * silent logger + broker + a tiny math service + the worker carrier in CHILD role (attaches to the
 * parentPort), then suspends until terminated by the host.
 */
import { Broker, DefaultBroker, defineAction, defineService, stream } from '@ozaco/server'
import { WorkerTransport } from '@ozaco/server/transport/worker'
import { flow, run, suspend } from '@ozaco/std/effect'
import { NodeIO } from '@ozaco/std/io/impl/node'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'

const mathService = defineService({
  name: 'math',
  version: '1.0.0',
  actions: {
    add: defineAction(function* (params) {
      return params.a + params.b
    }),

    countTo: defineAction({ output: stream() }, function* () {
      return flow(
        (async function* generate() {
          yield 1
          yield 2
          yield 3
        })(),
      )
    }),
  },
})

// NOT top-level awaited: a worker only starts DELIVERING inbound messages once its module
// evaluation settles — an `await run(...)` that suspends forever would queue them eternally.
void run(function* () {
  yield* install(NodeIO)
  yield* install(DefaultLogger, { level: LogLevel.silent })
  yield* install(DefaultBroker)
  yield* Broker.actions.register(mathService)
  yield* install(WorkerTransport)
  yield* Broker.actions.start()
  yield* suspend()
})
