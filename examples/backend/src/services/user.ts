import { Broker, defineAction, defineService } from 'server:core'
import { collect, ensure, into } from 'std:effect'
import { Logger } from 'std:logger'

import { z } from 'zod'

import { GreeterService } from './greeter'

export const UserService = defineService({
  name: 'users',
  version: '0.0.0',

  actions: {
    greet: defineAction(
      {
        input: z.string(),
      },
      function* (name) {
        yield* Logger.actions.info('Called greeting with:', name)

        return yield* Broker.actions.call(GreeterService.actions.salute, [name])
      },
    ),

    greetMany: defineAction(function* (names: string[]) {
      yield* Logger.actions.info('Called greetMany with:', names.join(', '))

      const input = into(names)

      const output = yield* Broker.actions.call(GreeterService.actions.saluteStream, ['Hi'], {
        streams: [input],
      })

      yield* ensure(function* () {
        yield* Logger.actions.info('Exiting:', names.join(', '))
      })

      return yield* collect<string>(output)
    }),
  },

  *setup() {},
})
