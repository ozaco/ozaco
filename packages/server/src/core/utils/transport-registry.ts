import { filter, operation, some, useContext } from 'std:effect'

import { TransportRegistryContext } from '../internal/context'
import { sortedEntries } from '../internal/transport-router'
import type { TransportDef } from '../types/transport'

export const registerTransport = operation(function* (
  entry: TransportDef,
  entryCtx: TransportDef.Context,
) {
  const existing = (yield* TransportRegistryContext.get()) ?? []

  if (
    yield* some(existing, function* (target) {
      const targetCtx = yield* useContext(target)

      return targetCtx.name === entryCtx.name
    })
  ) {
    return
  }

  yield* TransportRegistryContext.set(yield* sortedEntries([...existing, entry]))
})

export const unregisterTransport = operation(function* (entry: TransportDef) {
  const existing = (yield* TransportRegistryContext.get()) ?? []
  const entryCtx = yield* useContext(entry)

  yield* TransportRegistryContext.set(
    yield* filter(existing, function* (target) {
      const targetCtx = yield* useContext(target)

      return targetCtx.name === entryCtx.name
    }),
  )
})

export const getTransports = operation(function* () {
  return (yield* TransportRegistryContext.get()) ?? []
})
