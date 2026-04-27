import { operation, useContext } from 'std:effect'

import { NatsTransportImpl } from './impl'

export const isStartedAction = operation(function* () {
  const ctx = yield* useContext(NatsTransportImpl.context)
  return ctx.isStarted
})
