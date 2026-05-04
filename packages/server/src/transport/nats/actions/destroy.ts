import { operation, until, useContext } from 'std:effect'

import { NatsTransportImpl } from './impl'

export const destroyAction = operation(function* () {
  const ctx = yield* useContext(NatsTransportImpl.context)

  for (const sub of ctx.subscriptions.values()) {
    sub.unsubscribe()
  }
  ctx.subscriptions.clear()
  ctx.subjects.clear()

  yield* until(ctx.nc.close())

  ctx.isStarted = false
})
