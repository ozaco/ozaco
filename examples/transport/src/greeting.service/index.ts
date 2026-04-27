import { defineService, Transport, useSelf } from 'server:core'

import { greet } from './greet'

export const GreetingService = defineService({
  name: 'greeting',
  version: '0.0.1',
  actions: {
    greet,
  },

  *setup() {
    const self = yield* useSelf()

    yield* Transport.actions.mount(self)

    console.log('greeting service: up')
  },
})
