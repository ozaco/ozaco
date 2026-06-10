import type { Stream } from 'std:effect'
import { createChannel, each, ensure, operation, spawn } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { JSONParser } from '@streamparser/json'

import { Codec } from '../definitions'
import { CodecErrors } from '../errors'
import type { CodecDef } from '../types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const getSelf = (): CodecDef => JsonCodec

export const JsonCodec = Codec.implement({
  name: 'std/json-codec',
  version: '0.0.0',
  *setup(options: CodecDef.Options = {}) {
    const name = options.name ?? 'std/json-codec'
    const priority = options.priority ?? 999

    const context: CodecDef.Context = { name, priority }

    yield* Codec.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Codec.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  encode: operation(function* (value: unknown) {
    try {
      return encoder.encode(JSON.stringify(value))
    } catch (error) {
      return yield* fail(CodecErrors.Encode, error instanceof Error ? error.message : String(error))
    }
  }),

  decode: operation(function* (data: Uint8Array) {
    try {
      return JSON.parse(decoder.decode(data))
    } catch (error) {
      return yield* fail(CodecErrors.Decode, error instanceof Error ? error.message : String(error))
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
    let parser: JSONParser
    const pending: unknown[] = []
    let parseError: Result.Failure<unknown> | undefined

    yield* spawn(function* () {
      if (json) {
        parser = new JSONParser({ separator: '' })

        parser.onError = error => {
          parseError ??= asFailure(error)
        }

        parser.onValue = ({ value, stack }) => {
          if (stack.length > 0) {
            return
          }
          pending.push(value)
        }
      }

      const subscription = yield* stream
      let closeValue: true | Result.Failure<unknown> = asFailure(fail('cancelled', 'stream halted'))

      try {
        while (true) {
          const next = yield* subscription.next()
          if (next.done) {
            closeValue = (next.value ?? true) as true | Result.Failure<unknown>
            break
          }
          if (json) {
            parser.write(decoder.decode(next.value))
            while (pending.length > 0) {
              yield* channel.send(pending.shift())
            }
            if (parseError) {
              closeValue = parseError
              break
            }
          } else {
            yield* channel.send(decoder.decode(next.value))
          }
        }
      } finally {
        if (json) {
          try {
            parser.end()
            // oxlint-disable-next-line no-empty
          } catch {}

          while (pending.length > 0) {
            yield* channel.send(pending.shift())
          }

          if (parseError) {
            closeValue = parseError
          }
        }

        yield* channel.close(closeValue)
      }
    })

    return channel as Stream<AnyType, AnyType>
  }),
})
