import type { Flow } from 'std:effect'
import { createChannel, each, ensure, fork, operation } from 'std:effect'
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
}).build<CodecDef.JsonActions>({
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

  stringify: operation(function* (value, space = 0) {
    try {
      return JSON.stringify(value, null, space)
    } catch (error) {
      return yield* fail(
        CodecErrors.Stringify,
        error instanceof Error ? error.message : String(error),
      )
    }
  }),

  parse: operation(function* (text: string) {
    try {
      return JSON.parse(text)
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
            encoded = encoder.encode(JSON.stringify(chunk))
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

  decodeFlow: operation(function* (flow, json = true) {
    const channel = createChannel<unknown, true | Result.Failure<unknown>>()
    let parser: JSONParser
    const pending: unknown[] = []
    let parseError: Result.Failure<unknown> | undefined

    yield* fork(function* () {
      // per-stream decoder in streaming mode: a multi-byte UTF-8 sequence split across chunk
      // boundaries stays buffered until its remaining bytes arrive (the shared module-level
      // decoder would emit replacement characters and interleave state across streams)
      const streamDecoder = new TextDecoder()

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

      const subscription = yield* flow
      let closeValue: true | Result.Failure<unknown> = asFailure(fail('cancelled', 'flow halted'))

      try {
        while (true) {
          const next = yield* subscription.next()
          if (next.done) {
            closeValue = (next.value ?? true) as true | Result.Failure<unknown>
            break
          }
          const text = streamDecoder.decode(next.value, { stream: true })
          if (json) {
            parser.write(text)
            while (pending.length > 0) {
              yield* channel.send(pending.shift())
            }
            if (parseError) {
              closeValue = parseError
              break
            }
          } else if (text.length > 0) {
            yield* channel.send(text)
          }
        }
      } finally {
        const tail = streamDecoder.decode()

        if (json) {
          try {
            if (tail.length > 0) {
              parser.write(tail)
            }
            parser.end()
            // oxlint-disable-next-line no-empty
          } catch {}

          while (pending.length > 0) {
            yield* channel.send(pending.shift())
          }

          if (parseError) {
            closeValue = parseError
          }
        } else if (tail.length > 0) {
          yield* channel.send(tail)
        }

        yield* channel.close(closeValue)
      }
    })

    return channel as Flow<AnyType, AnyType>
  }),
})
