import { defineService, Transport, useSelf } from 'server:core'

import { add } from './add'
import { square } from './square'
import { sumOfSquares } from './sum-of-squares'

export const MathService = defineService({
  name: 'math',
  version: '0.0.1',
  actions: {
    add,
    square,
    sumOfSquares,
  },

  *setup() {
    const self = yield* useSelf()

    yield* Transport.actions.mount(self)

    console.log('math service: up')
  },
})
