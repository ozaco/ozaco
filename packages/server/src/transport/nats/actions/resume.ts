import { operation, useContext } from 'std:effect'

import { NatsTransportImpl } from './impl'

export const resumeAction = operation(function* () {
  const ctx = yield* useContext(NatsTransportImpl.context)
  ctx.isPaused = false
})
