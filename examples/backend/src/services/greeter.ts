import { defineAction, defineService } from 'server:core'
import { Logger } from 'std:logger'

export const GreeterService = defineService({
  name: 'greeter',
  version: '0.0.0',

  actions: {
    salute: defineAction(function* (name: string) {
      yield* Logger.actions.info('Saluting:', name)

      return `Hi ${name}` as const
    }),
  },

  *setup() {},
})
