import type { Flow } from 'std:effect'
import { createChannel, each, ensure, fork } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { parse, stringify } from 'smol-toml'

import pkg from '../../../package.json'
import { Codec } from '../definition'
import { CodecErrors } from '../errors'
import type { CodecDef } from '../types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const getSelf = (): CodecDef => TomlCodec

/**
 * A TOML codec for the `std:codec` registry, backed by `smol-toml` (an optional dependency — install
 * `smol-toml` alongside `@ozaco/std` to use it). `smol-toml` throws on bad input, so every action
 * wraps its call in try/catch and re-raises the thrown error as a `CodecErrors.*` failure (`Encode` /
 * `Decode` / `Stringify` / `Parse`). TOML datetimes pass through untouched — `smol-toml` parses them
 * into its `Date` subclass and nothing strips or rejects them. Default priority 500, below
 * `JsonCodec` (999): installing both keeps JSON as the default; register with a higher
 * `{ priority }` to prefer TOML, or install it alone.
 */
export const TomlCodec = Codec.implement({
  name: 'std/toml-codec',
  version: pkg.version,
  *setup(options: CodecDef.Options = {}) {
    const name = options.name ?? 'std/toml-codec'
    const priority = options.priority ?? 500

    const context: CodecDef.Context = { name, priority, ext: options.ext ?? 'toml' }

    yield* Codec.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Codec.actions.unregister(getSelf())
    })

    return context
  },
}).build<CodecDef.Actions>({
  *encode(value: unknown) {
    try {
      const result = stringify(value, {
        maxDepth: 100,
        numbersAsFloat: false,
      })

      return encoder.encode(result)
    } catch (error) {
      return yield* fail(CodecErrors.Encode, error instanceof Error ? error.message : String(error))
    }
  },

  *decode(data: Uint8Array) {
    try {
      return parse(decoder.decode(data), {
        maxDepth: 100,
        integersAsBigInt: false,
      }) as AnyType
    } catch (error) {
      return yield* fail(CodecErrors.Decode, error instanceof Error ? error.message : String(error))
    }
  },

  *stringify(value: unknown) {
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
  },

  *parse(text: string) {
    try {
      return parse(text, {
        maxDepth: 100,
        integersAsBigInt: false,
      }) as AnyType
    } catch (error) {
      return yield* fail(CodecErrors.Parse, error instanceof Error ? error.message : String(error))
    }
  },

  *encodeFlow(flow) {
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
  },

  *decodeFlow(flow) {
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
  },
})
