import { ensure, operation } from 'std:effect'
import { fail } from 'std:result'

import { CoreErrors } from '../const'
import { Codec } from '../definitions'
import type { CodecDef } from '../types/codec'
import { registerCodec, unregisterCodec } from '../utils/codec-registry'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const getSelf = (): CodecDef => JsonCodec

export const JsonCodec = Codec.implement({
  name: 'server/json-codec',
  version: '0.0.0',
  *setup(options: CodecDef.Options = {}) {
    const name = options.name ?? 'server/json-codec'
    const priority = options.priority ?? 999

    const context: CodecDef.Context = { name, priority }

    yield* registerCodec(getSelf(), context)
    yield* ensure(function* () {
      yield* unregisterCodec(getSelf())
    })

    return context
  },
}).build({
  encode: operation(function* (value: unknown) {
    try {
      return encoder.encode(JSON.stringify(value))
    } catch (error) {
      return yield* fail(
        CoreErrors.CodecEncode,
        error instanceof Error ? error.message : String(error),
      )
    }
  }),

  decode: operation(function* (data: Uint8Array) {
    try {
      return JSON.parse(decoder.decode(data))
    } catch (error) {
      return yield* fail(
        CoreErrors.CodecDecode,
        error instanceof Error ? error.message : String(error),
      )
    }
  }),
})
