import { Broker, DefaultBroker, defineAction, defineService, useService } from 'server:core'
import { main, suspend } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'

import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

const UserService = defineService({
  name: 'users',
  version: '0.0.0',

  actions: {
    greet: defineAction(function* (name: string) {
      yield* Logger.actions.info('Called greeting with:', name)

      return `Hi ${name}` as const
    }),
  },

  *setup() {
    const Self = yield* useService()

    yield* Broker.actions.register(Self)
  },
})

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger)
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker, {})

  yield* install(UserService)

  yield* Broker.actions.start()

  const response = yield* Broker.actions.call(UserService.actions.greet, ['Alice'])

  yield* Logger.actions.info('Broker response:', response)

  yield* suspend()
})
