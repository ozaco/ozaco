import type { Stream } from 'std:effect'
import { createChannel, each, ensure, operation, spawn, useScope } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { JSONParser } from '@streamparser/json'

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

  encodeStream: operation(function* (stream) {
    const channel = createChannel<Uint8Array, true | Result.Failure<unknown>>()

    yield* spawn(function* () {
      try {
        for (const chunk of yield* each(stream)) {
          yield* channel.send(encoder.encode(JSON.stringify(chunk)))

          yield* each.next()
        }
      } finally {
        yield* channel.close(true)
      }
    })

    yield* ensure(function* () {
      yield* channel.close(true)
    })

    return channel
  }),

  decodeStream: operation(function* (stream, json = true) {
    const channel = createChannel<unknown, true | Result.Failure<unknown>>()
    const scope = yield* useScope()
    let parser: JSONParser

    yield* spawn(function* () {
      if (json) {
        parser = new JSONParser({ separator: '' })

        parser.onEnd = () => {
          void scope.run(() => channel.close(true))
        }

        parser.onError = error => {
          void scope.run(() => channel.close(asFailure(error)))
        }

        parser.onValue = ({ value }) => {
          void scope.run(() => channel.send(value))
        }
      }

      try {
        for (const chunk of yield* each(stream)) {
          if (json) {
            parser.write(decoder.decode(chunk))
          } else {
            yield* channel.send(decoder.decode(chunk))
          }

          yield* each.next()
        }
      } finally {
        if (json) {
          parser.end()
        } else {
          yield* channel.close(true)
        }
      }
    })

    yield* ensure(function* () {
      yield* channel.close(true)
    })

    return channel as Stream<AnyType, AnyType>
  }),
})
