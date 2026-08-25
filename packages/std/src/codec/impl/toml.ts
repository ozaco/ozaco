import type { Flow } from 'std:effect'
import { createChannel, each, ensure, fork, operation } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { parse, stringify } from 'smol-toml'

import pkg from '../../../package.json'
import { Codec } from '../definitions'
import { CodecErrors } from '../errors'
import type { CodecDef } from '../types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const getSelf = (): CodecDef => TomlCodec

/**
 * A zero-dependency TOML codec for the `std:codec` registry (a from-scratch parser + serializer,
 * adapted from Deno's `@std/toml`; TOML datetimes are intentionally unsupported). `parseToml` /
 * `stringifyToml` return a `Result`, so this stays effect-native — the codec just `yield*`s the
 * failure, no try/catch. Default priority 500, below `JsonCodec` (999): installing both keeps JSON
 * as the default; register with a higher `{ priority }` to prefer TOML, or install it alone.
 */
export const TomlCodec = Codec.implement({
  name: 'std/toml-codec',
  version: pkg.version,
  *setup(options: CodecDef.Options = {}) {
    const name = options.name ?? 'std/toml-codec'
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
      const result = stringify(value, {
        maxDepth: 100,
        numbersAsFloat: false,
      })

      return encoder.encode(result)
    } catch (error) {
      return yield* fail(CodecErrors.Encode, error instanceof Error ? error.message : String(error))
    }
  }),

  decode: operation(function* (data: Uint8Array) {
    try {
      return parse(decoder.decode(data), {
        maxDepth: 100,
        integersAsBigInt: false,
      }) as AnyType
    } catch (error) {
      return yield* fail(CodecErrors.Decode, error instanceof Error ? error.message : String(error))
    }
  }),

  stringify: operation(function* (value: unknown) {
    try {
      return stringify(value, {
        maxDepth: 100,
        numbersAsFloat: false,
      })
    } catch (error) {
      return yield* fail(
        CodecErrors.Stringify,
        error instanceof Error ? error.message : String(error),
      )
    }
  }),

  parse: operation(function* (text: string) {
    try {
      return parse(text, {
        maxDepth: 100,
        integersAsBigInt: false,
      }) as AnyType
    } catch (error) {
      return yield* fail(CodecErrors.Parse, error instanceof Error ? error.message : String(error))
    }
  }),

  encodeFlow: operation(function* (flow) {
    const channel = createChannel<Uint8Array, true | Result.Failure<unknown>>()

    yield* fork(function* () {
      let close: true | Result.Failure<unknown> = true
      try {
        for (const chunk of yield* each(flow)) {
          let encoded: Uint8Array
          try {
            encoded = encoder.encode(
              stringify(chunk, {
                maxDepth: 100,
                numbersAsFloat: false,
              }),
            )
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
      } catch (error) {
        // the source closed with a Failure (raised by `each`) — forward the truncation through
        // this flow's own close instead of pretending a clean end
        close = asFailure(error)
      } finally {
        yield* channel.close(close)
      }
    })

    yield* ensure(function* () {
      yield* channel.close(true)
    })

    return channel
  }),

  decodeFlow: operation(function* (flow) {
    const channel = createChannel<unknown, true | Result.Failure<unknown>>()

    yield* fork(function* () {
      const streamDecoder = new TextDecoder()
      const parts: string[] = []
      let close: true | Result.Failure<unknown> = true

      const subscription = yield* flow
      for (;;) {
        const next = yield* subscription.next()
        if (next.done) {
          break
        }
        parts.push(streamDecoder.decode(next.value, { stream: true }))
      }
      parts.push(streamDecoder.decode())

      try {
        const result = parse(parts.join(''), {
          maxDepth: 100,
          integersAsBigInt: false,
        }) as AnyType

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

    return channel as Flow<AnyType, AnyType>
  }),
})
