import { operation, useContext } from 'std:effect'

import { NatsTransportImpl } from './impl'

export const isPausedAction = operation(function* () {
  const ctx = yield* useContext(NatsTransportImpl.context)
  return ctx.isPaused
})
