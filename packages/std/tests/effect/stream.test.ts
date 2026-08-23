import type { Flow } from 'std:effect'
import { ensure, fromReadable, run, scoped, sleep, toReadable, until } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const counting = (count: number, close: unknown): Flow<number, unknown> => ({
  *[Symbol.iterator]() {
    let at = 0
    return {
      *next() {
        if (at >= count) {
          return { done: true as const, value: close }
        }
        yield* sleep(1)
        return { done: false as const, value: at++ }
      },
    }
  },
})

/** Read a reader to its end into `into` (promise land, recursive — no await in a loop). */
const drainInto = <T>(reader: ReadableStreamDefaultReader<T>, into: T[]): Promise<void> =>
  reader.read().then(step => {
    if (step.done) {
      return undefined
    }
    into.push(step.value)
    return drainInto(reader, into)
  })

/** Drain a readable through a plain reader (promise land), collecting chunks. */
const drain = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const out: T[] = []
  // oxlint-disable-next-line no-await-in-loop -- sequential by nature: one pull at a time
  for await (const chunk of stream) {
    out.push(chunk)
  }
  return out
}

describe('toReadable', () => {
  it('pulls one item per read and closes cleanly with the flow', async () => {
    const got = unwrap(
      await run(function* () {
        const stream = yield* toReadable(counting(5, 'end'))
        return yield* until(drain(stream))
      }),
    )
    expect(got).toEqual([0, 1, 2, 3, 4])
  })

  it('a failing flow errors the stream with the failure itself', async () => {
    const outcome = unwrap(
      await run(function* () {
        const broken: Flow<number, unknown> = {
          *[Symbol.iterator]() {
            let n = 0
            return {
              *next() {
                n += 1
                if (n > 2) {
                  return { done: true as const, value: fail('source.broken', 'nope') }
                }
                return { done: false as const, value: n }
              },
            }
          },
        }
        const stream = yield* toReadable(broken)
        const seen: number[] = []
        const reader = stream.getReader()
        // read until the stream errors: the rejection IS the flow's failure
        const result = yield* until(
          drainInto(reader, seen).then(
            () => null,
            (error: unknown) => error,
          ),
        )
        return { seen, error: result }
      }),
    )
    expect(outcome.seen).toEqual([1, 2])
    expect(isFailure(outcome.error)).toBe(true)
    expect((outcome.error as { error: unknown }).error).toBe('source.broken')
  })

  it('cancelling the stream halts the pump and releases the flow', async () => {
    const released = unwrap(
      await run(function* () {
        let cleaned = false
        const slow: Flow<number, unknown> = {
          *[Symbol.iterator]() {
            yield* ensure(() => {
              cleaned = true
            })
            return {
              *next() {
                yield* sleep(10_000)
                return { done: false as const, value: 1 }
              },
            }
          },
        }
        const stream = yield* toReadable(slow)
        const reader = stream.getReader()
        void reader.read().catch(() => {})
        yield* sleep(20)
        yield* until(reader.cancel())
        yield* sleep(20)
        return cleaned
      }),
    )
    expect(released).toBe(true)
  })
})

describe('fromReadable', () => {
  it('reads every chunk and closes with the stream', async () => {
    const got = unwrap(
      await run(function* () {
        const stream = new ReadableStream<string>({
          start(controller) {
            controller.enqueue('a')
            controller.enqueue('b')
            controller.close()
          },
        })
        const sub = yield* fromReadable(stream)
        const out: string[] = []
        for (;;) {
          const step = yield* sub.next()
          if (step.done) {
            return out
          }
          out.push(step.value)
        }
      }),
    )
    expect(got).toEqual(['a', 'b'])
  })

  it('a consumer leaving mid-stream cancels the source', async () => {
    let cancelled = false
    unwrap(
      await run(function* () {
        const stream = new ReadableStream<number>({
          pull(controller) {
            controller.enqueue(1)
          },
          cancel() {
            cancelled = true
          },
        })
        yield* scoped(function* () {
          const sub = yield* fromReadable(stream)
          yield* sub.next()
        })
        yield* sleep(10)
      }),
    )
    expect(cancelled).toBe(true)
  })

  it('round-trip: a flow through toReadable and back keeps order and backpressure', async () => {
    const got = unwrap(
      await run(function* () {
        const stream = yield* toReadable(counting(20, undefined))
        const sub = yield* fromReadable(stream)
        const out: number[] = []
        for (;;) {
          const step = yield* sub.next()
          if (step.done) {
            return out
          }
          out.push(step.value)
        }
      }),
    )
    expect(got).toEqual(Array.from({ length: 20 }, (_, index) => index))
  })
})
