/**
 * A streaming action's dispatch span on the OWNING node covers the stream (design §6.2, live
 * finding #8): it stays open until the output closes — drained, failed or let go of — like the
 * caller's CLIENT span does, and the stream is PRODUCED under it (a log line, an `events()` item
 * of the feed land on the dispatch span). A Flow output and a platform stream output alike, in
 * process and over a network carrier.
 */
import type { ObserveDef, ServerDef } from 'server:core'
import { action, createServer, ObserveExporter, Server, service, stream } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, createQueue, flowOf, fork, run, scoped, sleep } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { createLink, MemoryTransport } from 'transport:impl/memory'
import { z } from 'zod'

import { storage } from '../helpers'

const STEP_MS = 15

let installs = 0

/** Every observed event of the node it is installed on, with the time it was exported. */
const memoryExporter = () => {
  installs += 1

  const events: { event: ObserveDef.Event; at: number }[] = []

  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: `test/stream-span-exporter-${installs}`,
    version: '1.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      events.push({ event, at: Date.now() })
    },
    *start() {},
    *flush() {},
  })

  const spans = (): TraceDef.SpanData[] =>
    events.flatMap(({ event }) => (event.t === 'span' ? [event.span] : []))
  const logs = (): TraceDef.LogData[] =>
    events.flatMap(({ event }) => (event.t === 'log' ? [event.log] : []))
  const span = (name: string): TraceDef.SpanData => {
    const found = spans().filter(data => data.name === name)

    if (found.length !== 1) {
      throw new Error(`expected one span "${name}", got ${found.length}`)
    }

    return found[0]!
  }
  const exceptions = (): TraceDef.LogData[] =>
    logs().filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, span, exceptions }
}

const encoder = new TextEncoder()

const feed = service('feed', {
  words: action.stream({ output: stream.ndjson(z.string()) }, function* ({ ctx }) {
    return flowOf<string>(function* (emit) {
      for (const word of ['a', 'b', 'c']) {
        yield* sleep(STEP_MS)
        // produced under the dispatch span: the line correlates to it
        yield* ctx.log.info('word', { word })
        yield* emit(word)
      }
    })
  }),
  broken: action.stream({ output: stream.ndjson(z.string()) }, function* () {
    return flowOf<string>(function* (emit) {
      yield* emit('first')
      yield* sleep(STEP_MS)

      return yield* fail('feed.broke', 'the feed broke')
    })
  }),
  endless: action.stream({ output: stream.ndjson(z.number()) }, function* () {
    return flowOf<number>(function* (emit) {
      for (let at = 0; ; at += 1) {
        yield* emit(at)
        yield* sleep(5)
      }
    })
  }),
  file: action.stream({ output: stream.bytes('text/plain') }, function* () {
    let sent = 0

    // a platform stream (a file, a fetch body): nothing of it runs in the dispatch's scope
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === 3) {
          controller.close()

          return
        }

        sent += 1
        await new Promise(resolve => {
          setTimeout(resolve, STEP_MS)
        })
        controller.enqueue(encoder.encode(`chunk ${sent}\n`))
      },
    })
  }),
})

/** Drain a branded stream in this scope; `limit` stops early (the consumer lets go). */
function* drain(out: unknown, limit = Number.POSITIVE_INFINITY): Operation<unknown[]> {
  const values: unknown[] = []
  const flow = yield* stream.flow(out as AnyType)

  while (values.length < limit) {
    const step = yield* flow.next()

    if (step.done) {
      break
    }

    values.push(step.value)
  }

  return values
}

/** One observing node hosting `feed`; `body` calls it in process. */
const local = async (
  body: (server: ServerDef.Handle<AnyType>) => Operation<void>,
  sink = memoryExporter(),
): Promise<ReturnType<typeof memoryExporter>> => {
  unwrap(
    await run(function* () {
      yield* storage()

      const server = yield* createServer({ services: [feed], plugins: [sink.plugin] })

      yield* body(server as AnyType)
    }),
  )

  return sink
}

describe('stream spans — the dispatch span covers its stream output', () => {
  it('in process: a Flow output keeps the INTERNAL dispatch span open until it is drained', async () => {
    let unread: string[] = []
    let drainedAt = 0
    const sink = memoryExporter()

    await local(function* (server) {
      yield* scoped(function* () {
        const out = yield* server.call(feed, 'words')

        unread = sink.spans().map(data => data.name)
        expect(yield* drain(out)).toEqual(['a', 'b', 'c'])
        drainedAt = Date.now()
      })
    }, sink)

    // not exported while the stream was unread
    expect(unread).not.toContain('feed.words')

    const words = sink.span('feed.words')

    expect(words).toMatchObject({ kind: 'internal', status: { code: 'unset' } })
    expect(words.end - words.start).toBeGreaterThanOrEqual(STEP_MS * 3 - 2)
    // ended with the drain — not whenever the node went down (wall clocks: a ms of slack)
    expect(words.end).toBeLessThanOrEqual(drainedAt + 5)

    // produced under the dispatch span: every line of the feed correlates to it, inside it
    const lines = sink.logs().filter(log => log.body === 'word')

    expect(lines).toHaveLength(3)

    for (const line of lines) {
      expect(line.context?.spanId).toBe(words.context.spanId)
      expect(line.time).toBeLessThanOrEqual(words.end)
    }
  })

  it('in process: a failure mid-stream fails the dispatch span — ONE record, at its origin', async () => {
    let failed: unknown

    const sink = await local(function* (server) {
      yield* scoped(function* () {
        const out = yield* server.call(feed, 'broken')

        failed = yield* attempt(() => drain(out))
      })
    })

    expect(isFailure(failed)).toBe(true)

    const broken = sink.span('feed.broken')

    expect(broken.status).toEqual({ code: 'error', message: 'the feed broke' })
    expect(broken.attributes['error.type']).toBe('feed.broke')

    const records = sink.exceptions()

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ eventName: 'ozaco.action.exception', severityNumber: 17 })
    expect(records[0]!.context?.spanId).toBe(broken.context.spanId)
  })

  it('in process: a consumer letting go ends the dispatch span cancelled', async () => {
    const sink = await local(function* (server) {
      yield* scoped(function* () {
        const out = yield* server.call(feed, 'endless')

        expect(yield* drain(out, 2)).toEqual([0, 1])
      })
      yield* sleep(10)
    })

    const endless = sink.span('feed.endless')

    expect(endless.status.code).toBe('unset')
    expect(endless.attributes['ozaco.cancelled']).toBe(true)
    expect(sink.exceptions()).toEqual([])
  })

  it('in process: a platform stream output ends the dispatch span when it is read out', async () => {
    let text = ''

    const sink = await local(function* (server) {
      yield* scoped(function* () {
        const out = yield* server.call(feed, 'file')
        const chunks = (yield* drain(out)) as Uint8Array[]

        text = chunks.map(chunk => new TextDecoder().decode(chunk)).join('')
      })
      // the span ends in the node's scope, a moment after the last chunk
      yield* sleep(10)
    })

    expect(text).toBe('chunk 1\nchunk 2\nchunk 3\n')

    const file = sink.span('feed.file')

    expect(file.status.code).toBe('unset')
    expect(file.end - file.start).toBeGreaterThanOrEqual(STEP_MS * 3 - 2)
  })

  it('over a network carrier: the owner’s SERVER span stays open until the lane is drained', async () => {
    const link = createLink()
    const owner = memoryExporter()
    const caller = memoryExporter()
    let drainedAt = 0

    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const remote = yield* fork(() =>
          scoped(function* () {
            yield* storage()
            yield* MemoryTransport.use({ prefix: 'app', link })
            yield* createServer({
              services: [feed],
              carrier: NetworkCarrier,
              name: 'app',
              instance: 'b',
              plugins: [owner.plugin],
            })
            ready.add(undefined)
            yield* sleep(60_000)
          }),
        )

        yield* ready.next()
        yield* scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'app', link })
          yield* createServer({
            services: [feed],
            hosted: [],
            role: 'gateway',
            carrier: NetworkCarrier,
            name: 'app',
            instance: 'a',
            timeoutMs: 2000,
            plugins: [caller.plugin],
          })
          yield* sleep(50)
          yield* scoped(function* () {
            const out = yield* Server.actions.call(feed, 'words')

            expect(yield* drain(out)).toEqual(['a', 'b', 'c'])
            drainedAt = Date.now()
          })
          yield* sleep(20)
        })
        yield* remote.halt()
      }),
    )

    const server = owner.span('feed.words')
    const client = caller.span('feed.words')

    expect(server).toMatchObject({ kind: 'server', status: { code: 'unset' } })
    expect(server.parent?.spanId).toBe(client.context.spanId)
    expect(server.end - server.start).toBeGreaterThanOrEqual(STEP_MS * 3 - 2)
    expect(server.end).toBeLessThanOrEqual(drainedAt + 5)

    // the feed's lines on the owner correlate to its SERVER span
    const lines = owner.logs().filter(log => log.body === 'word')

    expect(lines).toHaveLength(3)

    for (const line of lines) {
      expect(line.context?.spanId).toBe(server.context.spanId)
    }
  })
})
