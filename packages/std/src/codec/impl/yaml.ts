import type { Stream } from 'std:effect'
import { createChannel, each, ensure, operation, spawn } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { dump, load } from 'js-yaml'

import { Codec } from '../definitions'
import { CodecErrors } from '../errors'
import type { CodecDef } from '../types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const encodeOptions = {
  indent: 2,
  noRefs: true,
  lineWidth: 80,
  quotingType: "'" as const,
}
const decodeOptions = {
  json: true,
}

const getSelf = (): CodecDef => YamlCodec

/**
 * A YAML codec for the `std:codec` registry, backed by `js-yaml` (an optional peer dependency —
 * install `js-yaml` alongside `@ozaco/std` to use it). `encode` / `decode` return a `Result`, so this
 * stays effect-native — the codec just `yield*`s the failure, no try/catch. Default priority 500,
 * below `JsonCodec` (999): installing both keeps JSON as the default; register with a higher
 * `{ priority }` to prefer YAML, or install it alone.
 */
export const YamlCodec = Codec.implement({
  name: 'std/yaml-codec',
  version: '0.0.0',
  *setup(options: CodecDef.Options = {}) {
    const name = options.name ?? 'std/yaml-codec'
    const priority = options.priority ?? 500

    const context: CodecDef.Context = { name, priority }

    yield* Codec.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Codec.actions.unregister(getSelf())
    })

    return context
  },
}).build<CodecDef.Actions>({
  encode: operation(function* (value: unknown) {
    try {
      const result = dump(value, encodeOptions)

      return encoder.encode(result)
    } catch (error) {
      return yield* fail(CodecErrors.Encode, error instanceof Error ? error.message : String(error))
    }
  }),

  decode: operation(function* (data: Uint8Array) {
    try {
      return load(decoder.decode(data), decodeOptions) as AnyType
    } catch (error) {
      return yield* fail(CodecErrors.Decode, error instanceof Error ? error.message : String(error))
    }
  }),

  stringify: operation(function* (value: unknown) {
    try {
      return dump(value, encodeOptions)
    } catch (error) {
      return yield* fail(
        CodecErrors.Stringify,
        error instanceof Error ? error.message : String(error),
      )
    }
  }),

  parse: operation(function* (text: string) {
    try {
      return load(text, decodeOptions) as AnyType
    } catch (error) {
      return yield* fail(CodecErrors.Parse, error instanceof Error ? error.message : String(error))
    }
  }),

  encodeStream: operation(function* (stream) {
    const channel = createChannel<Uint8Array, true | Result.Failure<unknown>>()

    yield* spawn(function* () {
      let close: true | Result.Failure<unknown> = true
      try {
        for (const chunk of yield* each(stream)) {
          let encoded: Uint8Array
          try {
            encoded = encoder.encode(dump(chunk, encodeOptions))
          } catch (error) {
            close = fail(
              CodecErrors.Encode,
              error instanceof Error ? error.message : String(error),
            ) as Result.Failure<unknown>
            break
          }

          yield* channel.send(encoded)

          yield* each.next()
        }
      } finally {
        yield* channel.close(close)
      }
    })

    yield* ensure(function* () {
      yield* channel.close(true)
    })

    return channel
  }),

  decodeStream: operation(function* (stream) {
    const channel = createChannel<unknown, true | Result.Failure<unknown>>()

    yield* spawn(function* () {
      const streamDecoder = new TextDecoder()
      const parts: string[] = []
      let close: true | Result.Failure<unknown> = true

      const subscription = yield* stream
      for (;;) {
        const next = yield* subscription.next()
        if (next.done) {
          break
        }
        parts.push(streamDecoder.decode(next.value, { stream: true }))
      }
      parts.push(streamDecoder.decode())

      try {
        const result = load(parts.join(''), decodeOptions) as AnyType

        yield* channel.send(result)
      } catch (error) {
        close = asFailure(error)

        return yield* fail(
          CodecErrors.Decode,
          error instanceof Error ? error.message : String(error),
        )
      } finally {
        yield* channel.close(close)
      }
    })

    return channel as Stream<AnyType, AnyType>
  }),
})
