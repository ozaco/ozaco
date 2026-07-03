import type { Stream } from 'std:effect'
import { filter, operation, some, toSorted, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { CodecErrors } from '../errors'
import type { CodecDef } from '../types'

import { CodecRegistryContext } from './context'

export const sortedCodecs = operation(function* (entries: CodecDef[]) {
  return yield* toSorted(entries, function* (a, b) {
    const aCtx = yield* useContext(a)
    const bCtx = yield* useContext(b)

    return aCtx.priority - bCtx.priority
  })
})

export const codecEncode = operation(function* (value: unknown) {
  const entries = yield* codecGetTransportsHandler()

  if (entries.length === 0) {
    return yield* fail(CodecErrors.NoCodec, 'no codecs registered')
  }

  return yield* entries[0]!.actions.encode(value)
})

export const codecDecode = operation(function* (data: Uint8Array) {
  const entries = yield* codecGetTransportsHandler()

  if (entries.length === 0) {
    return yield* fail(CodecErrors.NoCodec, 'no codecs registered')
  }

  return yield* entries[0]!.actions.decode(data) as AnyType
})

export const codecEncodeStream = operation(function* <T>(stream: Stream<T, unknown>) {
  const entries = yield* codecGetTransportsHandler()

  if (entries.length === 0) {
    return yield* fail(CodecErrors.NoCodec, 'no codecs registered')
  }

  return yield* entries[0]!.actions.encodeStream<T>(stream)
})

export const codecDecodeStream = operation(function* <T>(
  stream: Stream<Uint8Array, unknown>,
  json = true,
) {
  const entries = yield* codecGetTransportsHandler()

  if (entries.length === 0) {
    return yield* fail(CodecErrors.NoCodec, 'no codecs registered')
  }

  return yield* entries[0]!.actions.decodeStream<T>(stream, json)
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

    yield* CodecRegistryContext.set(yield* sortedCodecs([...existing, transport]))
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
