/**
 * The SSE pump's close value: a clean end is `true`, a raised Failure closes the flow as is, and a
 * foreign throw (a parser bug, a transport fault) is an `asFailure` fold — `std:result.unknown`,
 * the thrown `Error` itself its `raw` (class and `code` intact), no nested level.
 */
import { AiErrors } from 'ai:core'
import type { Flow, Operation } from 'std:effect'
import { createQueue, run } from 'std:effect'
import { fail, isFailure, ResultErrors, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { byteFlow, sseFlow } from '../src/impl/openai/internal/sse'

import { drain } from './helpers'

const encoder = new TextEncoder()

/** A raw byte flow that yields `chunks`, then ends cleanly. */
const bytes = (...chunks: string[]): Flow<Uint8Array, void> =>
  ({
    *[Symbol.iterator]() {
      const queue = createQueue<Uint8Array, void>()
      for (const chunk of chunks) {
        queue.add(encoder.encode(chunk))
      }
      queue.close()
      return queue
    },
  }) as Flow<Uint8Array, void>

/** A raw byte flow whose first read throws `error` (a transport fault mid-flight). */
const faulty = (error: unknown): Flow<Uint8Array, void> =>
  ({
    *[Symbol.iterator]() {
      return {
        *next(): Operation<IteratorResult<Uint8Array, void>> {
          throw error
        },
      }
    },
  }) as unknown as Flow<Uint8Array, void>

/** The foreign value an `asFailure` fold was made of (its `raw`). */
const rawOf = (close: unknown): unknown => (isFailure(close) ? close.raw : undefined)

describe('sseFlow close', () => {
  it('a clean end closes true with every parsed event', async () => {
    const outcome = await run(function* () {
      const flow = yield* sseFlow(bytes('data: a\n\n', 'data: b\n\n'), function* (data) {
        return data
      })
      return yield* drain(flow)
    })

    expect(unwrap(outcome)).toEqual({ values: ['a', 'b'], close: true })
  })

  it('a raised Failure closes the flow as is', async () => {
    const outcome = await run(function* () {
      const flow = yield* sseFlow(bytes('data: x\n\n'), function* () {
        return yield* fail(AiErrors.BadResponse, 'garbage chunk')
      })
      return yield* drain(flow)
    })

    const { close } = unwrap(outcome)
    expect(isFailure(close) && close.error).toBe(AiErrors.BadResponse)
    expect((close as AnyType).message).toBe('garbage chunk')
  })

  it('a foreign throw in parse closes with the fold, the Error its raw', async () => {
    const thrown = new TypeError('cannot read properties of undefined')
    const outcome = await run(function* () {
      const flow = yield* sseFlow(bytes('data: x\n\n'), function* () {
        throw thrown
      })
      return yield* drain(flow)
    })

    const { close } = unwrap(outcome)
    expect(isFailure(close) && close.error).toBe(ResultErrors.Unknown)
    expect(rawOf(close)).toBe(thrown)
  })
})

describe('byteFlow close', () => {
  it('a transport fault closes with the fold, the platform Error (and its code) its raw', async () => {
    const fault = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const outcome = await run(function* () {
      const flow = yield* byteFlow(faulty(fault))
      return yield* drain(flow)
    })

    const { values, close } = unwrap(outcome)
    expect(values).toEqual([])
    expect(isFailure(close) && close.error).toBe(ResultErrors.Unknown)
    expect(rawOf(close)).toBe(fault)
    expect((rawOf(close) as AnyType).code).toBe('ECONNRESET')
    expect(isFailure(close) && close.causes).toEqual([])
  })
})
