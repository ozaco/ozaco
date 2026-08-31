import { action, createServer, service } from 'server:core'
import { attempt, run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { OtlpExporter, toCamelDeep } from 'server:plugins/observe/otlp'
import { z } from 'zod'

import { storage, todos } from '../helpers'

describe('observe/otlp', () => {
  it('toCamelDeep renames every nested key; leading underscores survive', () => {
    expect(toCamelDeep({ a_b: { c_d: [{ e_f: 1 }] }, _x_y: 2, plain: 3 })).toEqual({
      aB: { cD: [{ eF: 1 }] },
      _xY: 2,
      plain: 3,
    })
  })

  it('exports spans and logs as OTLP/JSON under the request trace; failures are counted', async () => {
    const received: { url: string; body: AnyType }[] = []
    let failing = false
    const fakeFetch = ((url: AnyType, init: AnyType) => {
      if (failing) {
        return Promise.resolve(new Response('nope', { status: 503 }))
      }
      received.push({ url: String(url), body: JSON.parse(init.body) })
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          name: 'otlp-demo',
          plugins: [
            OtlpExporter.use({
              url: 'http://collector:4318/',
              fetch: fakeFetch,
              batch: { waitMs: 20 },
              metrics: { intervalMs: 30 },
              resource: { 'deployment.environment': 'test' },
            }),
          ],
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'traced' })
        yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
        yield* sleep(80)

        const traces = received.filter(entry => entry.url.endsWith('/v1/traces'))
        const logs = received.filter(entry => entry.url.endsWith('/v1/logs'))
        expect(traces.length).toBeGreaterThan(0)
        const spans = traces.flatMap(entry => entry.body.resourceSpans[0].scopeSpans[0].spans)
        const create = spans.find((span: AnyType) => span.name === 'todos.create')
        expect(create).toBeDefined()
        expect(create.traceId).toMatch(/^[0-9a-f]{32}$/u)
        expect(create.spanId).toMatch(/^[0-9a-f]{16}$/u)
        expect(create.status).toEqual({ code: 1 })
        expect(create.attributes).toContainEqual({
          key: 'ozaco.kind',
          value: { stringValue: 'dispatch' },
        })
        // the recursive transformer fed it: the snake row crossed into camel attr world
        expect(create.attributes.some((attr: AnyType) => attr.key === 'ozaco.serviceId')).toBe(true)
        const explode = spans.find((span: AnyType) => span.name === 'todos.explode')
        expect(explode.status.code).toBe(2)
        // the error CONTENT rides on the span: tag + message attributes, human status message
        expect(explode.attributes).toContainEqual({
          key: 'error',
          value: { stringValue: 'x.y' },
        })
        expect(explode.status.message.length).toBeGreaterThan(0)
        expect(explode.status.message).not.toBe('failed')
        const resource = traces[0]!.body.resourceSpans[0].resource.attributes
        expect(resource).toContainEqual({
          key: 'service.name',
          value: { stringValue: 'otlp-demo' },
        })
        expect(resource).toContainEqual({
          key: 'deployment.environment',
          value: { stringValue: 'test' },
        })
        const records = logs.flatMap(entry => entry.body.resourceLogs[0].scopeLogs[0].logRecords)
        const creating = records.find((record: AnyType) => record.body.stringValue === 'creating')
        expect(creating.severityText).toBe('INFO')
        expect(creating.traceId).toBe(create.traceId)
        const failure = records.find((record: AnyType) => record.severityText === 'ERROR')
        expect(failure.attributes).toContainEqual({
          key: 'exception.type',
          value: { stringValue: 'x.y' },
        })

        // CUMULATIVE metrics beat: request counters, the duration histogram, failure counters
        const metricPayloads = received.filter(entry => entry.url.endsWith('/v1/metrics'))
        expect(metricPayloads.length).toBeGreaterThan(0)
        const metrics = metricPayloads.at(-1)!.body.resourceMetrics[0].scopeMetrics[0].metrics
        const requests = metrics.find((metric: AnyType) => metric.name === 'ozaco.requests')
        const createCount = requests.sum.dataPoints.find((point: AnyType) =>
          point.attributes.some(
            (attr: AnyType) =>
              attr.key === 'ozaco.action' && attr.value.stringValue === 'todos.create',
          ),
        )
        expect(createCount).toMatchObject({ asInt: '1' })
        expect(createCount.attributes).toContainEqual({
          key: 'ozaco.status',
          value: { stringValue: 'ok' },
        })
        const duration = metrics.find((metric: AnyType) => metric.name === 'ozaco.request.duration')
        const histogram = duration.histogram.dataPoints.find((point: AnyType) =>
          point.attributes.some(
            (attr: AnyType) =>
              attr.key === 'ozaco.action' && attr.value.stringValue === 'todos.create',
          ),
        )
        expect(Number(histogram.count)).toBeGreaterThanOrEqual(1)
        expect(histogram.explicitBounds.length + 1).toBe(histogram.bucketCounts.length)
        const failCounts = metrics.find((metric: AnyType) => metric.name === 'ozaco.failures')
        expect(failCounts.sum.dataPoints[0].attributes).toContainEqual({
          key: 'ozaco.tag',
          value: { stringValue: 'x.y' },
        })

        // a collector outage never reaches the caller
        failing = true
        const sent = received.length
        const made = yield* server.call(todos, 'create', { title: 'unsent' })
        expect(made.title).toBe('unsent')
        yield* sleep(80)
        expect(received.length).toBe(sent)
        yield* server.stop()
      }),
    )
  })
})

/**
 * A socket session is ONE span that only ends when the socket closes — without the events leg
 * everything that happened inside it (every frame) is missing from the trace.
 */
const chat = service('chat', {
  room: action.socket(
    { protocol: 'chat', receives: z.object({ text: z.string() }) },
    function* (socket) {
      yield* socket.send({ t: 'hello' })
      const messages = yield* socket.messages

      for (;;) {
        const step = yield* messages.next()

        if (step.done) {
          return
        }

        yield* socket.send({ t: 'echo', text: step.value.text })
      }
    },
  ),
})

/** Open the room, say one thing, wait for the echo, close. Resolves with the frames received. */
const talk = async (url: string, said: string): Promise<string[]> => {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/chat/room`)
  const frames: string[] = []

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', event => {
      frames.push(String(event.data))

      if (frames.length === 1) {
        ws.send(JSON.stringify({ text: said }))
      }

      if (frames.length === 2) {
        ws.close()
        resolve()
      }
    })
    ws.addEventListener('error', () => reject(new Error('socket error')))
  })

  return frames
}

/** Every `/v1/traces` span the collector saw, flattened. */
const spansOf = (received: readonly { url: string; body: AnyType }[]): AnyType[] =>
  received
    .filter(entry => entry.url.endsWith('/v1/traces'))
    .flatMap(entry => entry.body.resourceSpans[0].scopeSpans[0].spans)

const attr = (span: AnyType, key: string): AnyType =>
  span.attributes.find((entry: AnyType) => entry.key === key)?.value

describe('observe/otlp — events', () => {
  it('projects WS frames and emits into the trace under the span they happened in', async () => {
    const received: { url: string; body: AnyType }[] = []
    const fakeFetch = ((url: AnyType, init: AnyType) => {
      received.push({ url: String(url), body: JSON.parse(init.body) })
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [chat, todos],
          edge: BunEdge,
          plugins: [
            OtlpExporter.use({
              url: 'http://collector:4318',
              fetch: fakeFetch,
              batch: { waitMs: 20 },
              metrics: false,
            }),
          ],
        })
        const info = yield* server.start({ port: 0 })

        expect((yield* until(talk(info.url!, 'hi there'))).length).toBe(2)
        yield* sleep(120)

        const spans = spansOf(received)
        const session = spans.find((span: AnyType) => span.name === 'WS /chat/room')
        expect(session).toBeDefined()

        // the frames: one inbound, two outbound (`hello` then the echo)
        const inbound = spans.filter((span: AnyType) => span.name === 'WS → /chat/room')
        const outbound = spans.filter((span: AnyType) => span.name === 'WS ← /chat/room')
        expect(inbound.length).toBe(1)
        expect(outbound.length).toBe(2)

        // …hanging off the SESSION span, in the session's trace
        for (const frame of [...inbound, ...outbound]) {
          expect(frame.traceId).toBe(session.traceId)
          expect(frame.parentSpanId).toBe(session.spanId)
          expect(frame.spanId).toMatch(/^[0-9a-f]{16}$/u)
          // a frame is a point in time, not a duration
          expect(frame.startTimeUnixNano).toBe(frame.endTimeUnixNano)
          expect(attr(frame, 'ozaco.kind')).toEqual({ stringValue: 'event' })
          expect(Number((attr(frame, 'ozaco.size') as AnyType).intValue)).toBeGreaterThan(0)
        }
        expect(attr(inbound[0], 'ozaco.event')).toEqual({ stringValue: 'socket-in' })
        expect(attr(outbound[0], 'ozaco.event')).toEqual({ stringValue: 'socket-out' })
        expect(attr(inbound[0], 'ozaco.data')).toBeUndefined()

        // frames sharing a millisecond still get distinct span ids
        expect(new Set(spans.map((span: AnyType) => span.spanId)).size).toBe(spans.length)

        // an `emit` hangs off the DISPATCH that emitted, not off a socket
        yield* server.call(todos, 'nested', { title: 'emitted' })
        yield* sleep(120)
        const after = spansOf(received)
        const emitted = after.find((span: AnyType) => span.name === 'emit todo.created')
        expect(emitted).toBeDefined()
        expect(attr(emitted, 'ozaco.event')).toEqual({ stringValue: 'emit' })
        const nested = after.find((span: AnyType) => span.name === 'todos.nested')
        expect(emitted.traceId).toBe(nested.traceId)
        expect(emitted.parentSpanId).toBe(nested.spanId)

        yield* server.stop()
      }),
    )
  })

  it('carries frame payloads with events: { data: true } and drops them with events: false', async () => {
    const withData: { url: string; body: AnyType }[] = []
    const capture = (into: { url: string; body: AnyType }[]) =>
      ((url: AnyType, init: AnyType) => {
        into.push({ url: String(url), body: JSON.parse(init.body) })
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as typeof fetch

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [chat],
          edge: BunEdge,
          plugins: [
            OtlpExporter.use({
              url: 'http://collector:4318',
              fetch: capture(withData),
              batch: { waitMs: 20 },
              metrics: false,
              events: { data: true },
            }),
          ],
        })
        const info = yield* server.start({ port: 0 })
        yield* until(talk(info.url!, 'payload'))
        yield* sleep(120)

        const inbound = spansOf(withData).find((span: AnyType) => span.name === 'WS → /chat/room')
        expect(attr(inbound, 'ozaco.data')).toEqual({
          stringValue: JSON.stringify({ text: 'payload' }),
        })
        yield* server.stop()
      }),
    )

    const withoutEvents: { url: string; body: AnyType }[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [chat],
          edge: BunEdge,
          plugins: [
            OtlpExporter.use({
              url: 'http://collector:4318',
              fetch: capture(withoutEvents),
              batch: { waitMs: 20 },
              metrics: false,
              events: false,
            }),
          ],
        })
        const info = yield* server.start({ port: 0 })
        yield* until(talk(info.url!, 'quiet'))
        yield* sleep(120)

        const spans = spansOf(withoutEvents)
        // the session span still lands — only the frames are gone
        expect(spans.some((span: AnyType) => span.name === 'WS /chat/room')).toBe(true)
        expect(spans.some((span: AnyType) => span.name.startsWith('WS →'))).toBe(false)
        expect(spans.some((span: AnyType) => span.name.startsWith('WS ←'))).toBe(false)
        yield* server.stop()
      }),
    )
  })
})
