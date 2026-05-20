import { filter, operation, some, useContext } from 'std:effect'

import { sortedCodecs } from '../internal/codec-router'
import { CodecRegistryContext } from '../internal/context'
import type { CodecDef } from '../types/codec'

export const registerCodec = operation(function* (entry: CodecDef, entryCtx: CodecDef.Context) {
  const existing = (yield* CodecRegistryContext.get()) ?? []

  if (
    yield* some(existing, function* (target) {
      const targetCtx = yield* useContext(target)

      return targetCtx.name === entryCtx.name
    })
  ) {
    return
  }

  yield* CodecRegistryContext.set(yield* sortedCodecs([...existing, entry]))
})

export const unregisterCodec = operation(function* (entry: CodecDef) {
  const existing = (yield* CodecRegistryContext.get()) ?? []
  const entryCtx = yield* useContext(entry)

  yield* CodecRegistryContext.set(
    yield* filter(existing, function* (target) {
      const targetCtx = yield* useContext(target)

      return targetCtx.name !== entryCtx.name
    }),
  )
})

export const getCodecs = operation(function* () {
  return (yield* CodecRegistryContext.get()) ?? []
})
