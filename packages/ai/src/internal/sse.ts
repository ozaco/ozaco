import type { Operation, Stream } from 'std:effect'
import { createChannel, each, ensure, operation, spawn } from 'std:effect'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { AiDef } from '../types'

import { parseChatChunk, parseTranscriptDelta } from './parse'

/** Split a buffered SSE text region into complete events, returning the unconsumed tail. */
const splitEvents = (buffer: string): { events: string[]; rest: string } => {
  const parts = buffer.split(/\r?\n\r?\n/u)
  const rest = parts.pop() ?? ''
  return { events: parts, rest }
}

/** Collect the `data:` lines of one SSE event into a single payload string. */
const eventData = (event: string): string =>
  event
    .split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')

/**
 * Turn a raw SSE byte stream into a `Stream<T>` by parsing each event's `data:` payload with
 * `parseEvent` (`undefined` = the `[DONE]` sentinel / no more events → stop). Buffers partial chunks
 * across event boundaries; `keep` decides whether a parsed value is forwarded (so `transcriptStream`
 * can drop empty text while `chatStream` forwards every chunk, including usage-only ones). Runs the
 * pump in a SPAWNED task within the consumer's scope: when that scope is halted, the pump tears down
 * AND the fetch that produced `raw` aborts (its `useAbortSignal()` resource is owned by the same
 * scope), so halting a stream cancels the in-flight request — essential for barge-in. The shared pump
 * behind `chatStream` and `transcriptStream`.
 */
const sseStream = operation(function* <T>(
  raw: Stream<Uint8Array, void>,
  parseEvent: (data: string) => Operation<T | undefined, AnyType>,
  keep: (value: T) => boolean = () => true,
): Generator<AnyType, Stream<T, AiDef.StreamClose>, AnyType> {
  const channel = createChannel<T, AiDef.StreamClose>()

  yield* spawn(function* () {
    const decoder = new TextDecoder()
    let buffer = ''
    let close: AiDef.StreamClose = true
    try {
      for (const chunk of yield* each(raw)) {
        buffer += decoder.decode(chunk, { stream: true })
        const { events, rest } = splitEvents(buffer)
        buffer = rest
        for (const event of events) {
          const value = yield* parseEvent(eventData(event))
          if (value === undefined) {
            return
          }
          if (keep(value)) {
            yield* channel.send(value)
          }
        }
        yield* each.next()
      }
      buffer += decoder.decode()
      const tail = yield* parseEvent(eventData(buffer))
      if (tail !== undefined && keep(tail)) {
        yield* channel.send(tail)
      }
    } catch (error) {
      close = asFailure(error)
    } finally {
      yield* channel.close(close)
    }
  })

  yield* ensure(function* () {
    yield* channel.close(true)
  })

  return channel
})

/**
 * Turn the raw byte stream of a streaming `/chat/completions` response into a `Stream` of
 * `ChatStreamChunk`s — every event is forwarded (including the final usage-only chunk). Buffers
 * partial chunks across SSE event boundaries and stops on the `[DONE]` sentinel.
 */
export const chatChunkStream = operation(function* (raw: Stream<Uint8Array, void>) {
  return yield* sseStream(raw, parseChatChunk)
})

/**
 * Turn the raw byte stream of a streaming `/audio/transcriptions` response into a `Stream` of
 * transcript text deltas. Buffers partial chunks across SSE event boundaries and stops on `[DONE]`.
 */
export const transcriptStream = operation(function* (raw: Stream<Uint8Array, void>) {
  return yield* sseStream(raw, parseTranscriptDelta, delta => delta.length > 0)
})

/**
 * Re-channel a raw `Stream<Uint8Array, void>` (from `.raw()`) into a `Stream<Uint8Array,
 * StreamClose>` that forwards chunks verbatim, closing with `true` on a clean end or a failure if
 * one is raised mid-stream — matching the close semantics of the SSE streams. Used by `ttsStream`.
 */
export const byteStream = operation(function* (
  raw: Stream<Uint8Array, void>,
): Generator<AnyType, Stream<Uint8Array, AiDef.StreamClose>, AnyType> {
  const channel = createChannel<Uint8Array, AiDef.StreamClose>()

  yield* spawn(function* () {
    let close: AiDef.StreamClose = true
    try {
      for (const chunk of yield* each(raw)) {
        yield* channel.send(chunk)
        yield* each.next()
      }
    } catch (error) {
      close = asFailure(error)
    } finally {
      yield* channel.close(close)
    }
  })

  yield* ensure(function* () {
    yield* channel.close(true)
  })

  return channel
})
