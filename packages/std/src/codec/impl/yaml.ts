import type { Flow } from 'std:effect'
import { createChannel, each, ensure, fork } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { dump, load } from 'js-yaml'

import pkg from '../../../package.json'
import { Codec } from '../definition'
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
 * A YAML codec for the `std:codec` registry, backed by `js-yaml` (an optional dependency — install
 * `js-yaml` alongside `@ozaco/std` to use it). `js-yaml` throws on bad input, so every action wraps
 * its call in try/catch and re-raises the thrown error as a `CodecErrors.*` failure (`Encode` /
 * `Decode` / `Stringify` / `Parse`). Default priority 500, below `JsonCodec` (999): installing both
 * keeps JSON as the default; register with a higher `{ priority }` to prefer YAML, or install it
 * alone. Shipped for consumers: nothing inside the monorepo installs it (config defaults to
 * `TomlCodec`), so its only in-repo coverage is its own test file.
 */
export const YamlCodec = Codec.implement({
  name: 'std/yaml-codec',
  version: pkg.version,
  *setup(options: CodecDef.Options = {}) {
    const name = options.name ?? 'std/yaml-codec'
    const priority = options.priority ?? 500

    const context: CodecDef.Context = { name, priority, ext: options.ext ?? 'yaml' }

    yield* Codec.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Codec.actions.unregister(getSelf())
    })

    return context
  },
}).build<CodecDef.Actions>({
  *encode(value: unknown) {
    try {
      const result = dump(value, encodeOptions)

      return encoder.encode(result)
    } catch (error) {
      return yield* fail(CodecErrors.Encode, error instanceof Error ? error.message : String(error))
    }
  },

  *decode(data: Uint8Array) {
    try {
      return load(decoder.decode(data), decodeOptions) as AnyType
    } catch (error) {
      return yield* fail(CodecErrors.Decode, error instanceof Error ? error.message : String(error))
    }
  },

  *stringify(value: unknown) {
    try {
      return dump(value, encodeOptions)
    } catch (error) {
      return yield* fail(
        CodecErrors.Stringify,
        error instanceof Error ? error.message : String(error),
      )
    }
  },

  *parse(text: string) {
    try {
      return load(text, decodeOptions) as AnyType
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

  /**
   * A WHOLE-DOCUMENT decoder: buffers the source and emits one value after it closes (there is no
   * second `json` parameter here — that switch is `JsonCodec`'s). Two known rough edges, both
   * pinned by the tests: the source's close value is never read, so an upstream FAILURE close is
   * dropped and the bytes received so far are parsed as if complete; and a parse error both closes
   * the channel with the failure AND fails the forked decoder, which fails the scope that called
   * `decodeFlow` with `CodecErrors.Decode` (`JsonCodec` only closes the channel).
   */
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

    return channel as Flow<AnyType, AnyType>
  },
})
