import { operation, useContext } from 'std:effect'

import { NatsTransportImpl } from './impl'

export const pauseAction = operation(function* (cause: string) {
  const ctx = yield* useContext(NatsTransportImpl.context)
  ctx.isPaused = cause
})
