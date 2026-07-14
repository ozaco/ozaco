import { filter, operation, some, toSorted, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { CodecDef } from '../types'

import { CodecRegistryContext } from './context'

export const sortedCodecs = operation(function* (
  entries: CodecDef[],
  transport: CodecDef,
  transportCtx: CodecDef.Context,
) {
  return yield* toSorted(entries, function* (a, b) {
    const aCtx = a === transport ? transportCtx : yield* useContext(a)
    const bCtx = b === transport ? transportCtx : yield* useContext(b)

    return aCtx.priority - bCtx.priority
  })
})

export const codecRegisterHandler: CodecDef.Handlers['register'] = operation(
  function* (transport, transportCtx) {
    const existing = yield* codecGetTransportsHandler()

    if (
      yield* some(existing, function* (target) {
        const targetCtx = yield* useContext(target)

        return targetCtx.name === transportCtx.name
      })
    ) {
      return yield* fail('unexpected', `codec ${transportCtx.name} is already registered`)
    }

    yield* CodecRegistryContext.set(
      yield* sortedCodecs([...existing, transport], transport, transportCtx),
    )
  },
)

export const codecUnregisterHandler: CodecDef.Handlers['unregister'] = operation(
  function* (transport) {
    const existing = yield* codecGetTransportsHandler()
    const transportCtx = yield* useContext(transport)

    yield* CodecRegistryContext.set(
      yield* filter(existing, function* (target) {
        const targetCtx = yield* useContext(target)

        return targetCtx.name !== transportCtx.name
      }),
    )
  },
)

export const codecGetTransportsHandler: CodecDef.Handlers['getTransports'] = operation(
  function* () {
    return (yield* CodecRegistryContext.get()) ?? []
  },
)
