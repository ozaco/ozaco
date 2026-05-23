import { defineAction, defineService, useStream } from 'server:core'
import { createChannel, each, ensure, sleep, spawn } from 'std:effect'
import { Logger } from 'std:logger'
import { fail } from 'std:result'

export const GreeterService = defineService({
  name: 'greeter',
  version: '0.0.0',

  actions: {
    salute: defineAction(function* (name: string) {
      yield* Logger.actions.info('Saluting:', name)

      return `Hi ${name}` as const
    }),

    saluteStream: defineAction(function* (greeting: string) {
      const [input] = yield* useStream<string>()

      if (!input) {
        return yield* fail('missing-input', 'saluteStream requires an input stream')
      }

      yield* Logger.actions.info('Starting saluteStream with greeting:', greeting)

      yield* ensure(function* () {
        yield* Logger.actions.info('Exiting greeter', greeting)
      })

      const outputChannel = createChannel<string>()

      yield* spawn(function* () {
        try {
          for (const name of yield* each(input)) {
            yield* Logger.actions.info('Saluting (stream):', name)

            yield* sleep(10_000)

            yield* outputChannel.send(`${greeting} ${name}`)
            yield* each.next()
          }
        } finally {
          yield* outputChannel.close()
        }
      })

      return outputChannel
    }),
  },

  *setup() {},
})
