import {
  Broker,
  DefaultBroker,
  DefaultTracer,
  defineAction,
  defineService,
  useService,
} from 'server:core'
import { main, suspend } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'

import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

const GreeterService = defineService({
  name: 'greeter',
  version: '0.0.0',

  actions: {
    salute: defineAction(function* (name: string) {
      yield* Logger.actions.info('Saluting:', name)

      return `Hi ${name}` as const
    }),
  },

  *setup() {
    yield* Broker.actions.register(yield* useService())
  },
})

const UserService = defineService({
  name: 'users',
  version: '0.0.0',

  actions: {
    greet: defineAction(function* (name: string) {
      yield* Logger.actions.info('Called greeting with:', name)

      return yield* Broker.actions.call(GreeterService.actions.salute, [name])
    }),
  },

  *setup() {
    yield* Broker.actions.register(yield* useService())
  },
})

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger)
  yield* install(ConsoleTransport)

  yield* install(DefaultTracer, {
    onSpanEnd(snapshot) {
      const { traceId, spanId, parentSpanId } = snapshot.context
      console.log(
        `[span] ${snapshot.name}  trace=${traceId}  span=${spanId}  parent=${parentSpanId ?? '-'}  dur=${(snapshot.endTime - snapshot.startTime).toFixed(3)}ms`,
      )
    },
  })

  yield* install(DefaultBroker)

  yield* install(GreeterService)
  yield* install(UserService)

  yield* Broker.actions.start()

  const response = yield* Broker.actions.call(UserService.actions.greet, ['Alice'])

  yield* Logger.actions.info('Broker response:', response)

  yield* suspend()
})
