/**
 * Feeds: every OUTPUT brand — `ndjson` (values, one per line), `sse` (server-sent events),
 * `text` (a text stream) and `bytes` (a raw download) — plus a slow action that honours
 * cancellation and a deadline.
 */
import { action, service, stream } from 'server:core'
import type { Flow } from 'std:effect'
import { flowOf, sleep } from 'std:effect'

import { z } from 'zod'

const Tick = z.object({ n: z.number(), at: z.number() })

/** A Flow of `n` ticks, `everyMs` apart — `flowOf`: emit values, `return` ends the stream (the
 * handler's own scope cancels it with the request). */
const ticks = (n: number, everyMs: number): Flow<{ n: number; at: number }, void> =>
  flowOf(function* (emit) {
    for (let at = 0; at < n; at += 1) {
      if (at > 0) {
        yield* sleep(everyMs)
      }

      yield* emit({ n: at, at: Date.now() })
    }
  })

export const feed = service(
  'feed',
  {
    ticks: action.stream(
      {
        input: z.object({
          n: z.number().int().min(1).max(1000).default(5),
          everyMs: z.number().default(100),
        }),
        output: stream.ndjson(Tick),
        description: 'NDJSON: one JSON value per line',
      },
      function* ({ input }) {
        return ticks(input.n, input.everyMs)
      },
    ),
    events: action.stream(
      {
        input: z.object({
          n: z.number().int().min(1).max(1000).default(5),
          everyMs: z.number().default(100),
        }),
        output: stream.sse(Tick),
        description: 'Server-sent events (text/event-stream)',
      },
      function* ({ input }) {
        return ticks(input.n, input.everyMs)
      },
    ),
    words: action.stream(
      {
        input: z.object({ text: z.string().default('the quick brown fox') }),
        output: stream.text(),
        description: 'A text stream, one word at a time',
      },
      function* ({ input }) {
        return flowOf<string>(function* (emit) {
          for (const word of input.text.split(' ')) {
            yield* sleep(10)
            yield* emit(`${word} `)
          }
        })
      },
    ),
    download: action.stream(
      {
        input: z.object({ kb: z.number().int().min(1).max(10_000).default(64) }),
        output: stream.bytes('application/octet-stream'),
        description: 'A raw byte download of `kb` kilobytes',
      },
      function* ({ input }) {
        let sent = 0
        const total = input.kb * 1024
        return stream.from(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= total) {
                controller.close()
                return
              }
              const chunk = new Uint8Array(Math.min(16 * 1024, total - sent)).fill(sent % 251)
              sent += chunk.length
              controller.enqueue(chunk)
            },
          }),
          'bytes:application/octet-stream',
        )
      },
    ),
    slow: action.query(
      {
        input: z.object({ ms: z.number().int().min(0).max(60_000).default(2000) }),
        output: z.object({ sleptMs: z.number(), aborted: z.boolean() }),
        timeoutMs: 10_000,
        description: 'Sleeps; a caller that leaves aborts it (ctx.signal), a deadline cuts it',
      },
      function* ({ input, ctx }) {
        const started = Date.now()
        yield* sleep(input.ms)
        return { sleptMs: Date.now() - started, aborted: ctx.signal.aborted }
      },
    ),
  },
  { version: '1.0.0', description: 'Streams of every brand' },
)
