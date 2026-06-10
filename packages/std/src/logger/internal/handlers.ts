import { filter, operation, some, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { LoggerDef } from '../types/logger'

import { LoggerTransportRegistryContext } from './context'

export const registerHandler: LoggerDef.Handlers['register'] = operation(
  function* (transport, transportCtx) {
    const existing = (yield* LoggerTransportRegistryContext.get()) ?? []

    if (
      yield* some(existing, function* (target) {
        const targetCtx = yield* useContext(target)

        return targetCtx.name === transportCtx.name
      })
    ) {
      return yield* fail(
        'unexpected',
        `Logger transport ${transportCtx.name} is already registered`,
      )
    }

    yield* LoggerTransportRegistryContext.set([...existing, transport])
  },
)

export const unregisterHandler: LoggerDef.Handlers['unregister'] = operation(function* (transport) {
  const existing = (yield* LoggerTransportRegistryContext.get()) ?? []
  const transportCtx = yield* useContext(transport)

  yield* LoggerTransportRegistryContext.set(
    yield* filter(existing, function* (target) {
      const targetCtx = yield* useContext(target)

      return targetCtx.name !== transportCtx.name
    }),
  )
})

export const getTransportsHandler: LoggerDef.Handlers['getTransports'] = operation(function* () {
  return (yield* LoggerTransportRegistryContext.get()) ?? []
})
