import { operation, useContext } from 'std:effect'
import { filter, some } from 'std:shared'

import { TransportRegistryContext } from '../internal/context'
import { sortedEntries } from '../internal/transport-router'
import type { TransportDef } from '../types/transport'

export const registerTransport = operation(function* (entry: TransportDef.Anyof) {
  const existing = (yield* TransportRegistryContext.get()) ?? []

  const entryCtx = yield* useContext(entry)

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

export const unregisterTransport = operation(function* (name: string) {
  const existing = (yield* TransportRegistryContext.get()) ?? []

  yield* TransportRegistryContext.set(
    yield* filter(existing, function* (target) {
      const targetCtx = yield* useContext(target)

      return targetCtx.name === name
    }),
  )
})

export const getTransports = operation(function* () {
  return (yield* TransportRegistryContext.get()) ?? []
})
