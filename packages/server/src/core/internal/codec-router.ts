import { operation, toSorted, useContext } from 'std:effect'
import { fail } from 'std:result'

import { CoreErrors } from '../const'
import type { CodecDef } from '../types/codec'

import { CodecRegistryContext } from './context'

export const sortedCodecs = operation(function* (entries: CodecDef[]) {
  return yield* toSorted(entries, function* (a, b) {
    const aCtx = yield* useContext(a)
    const bCtx = yield* useContext(b)

    return aCtx.priority - bCtx.priority
  })
})

export const codecEncode = operation(function* (value: unknown) {
  const entries = (yield* CodecRegistryContext.get()) ?? []

  if (entries.length === 0) {
    return yield* fail(CoreErrors.MissingSettings, 'no codecs registered')
  }

  return yield* entries[0]!.actions.encode(value)
})

export const codecDecode = operation(function* (data: Uint8Array) {
  const entries = (yield* CodecRegistryContext.get()) ?? []

  if (entries.length === 0) {
    return yield* fail(CoreErrors.MissingSettings, 'no codecs registered')
  }

  return yield* entries[0]!.actions.decode(data)
})
