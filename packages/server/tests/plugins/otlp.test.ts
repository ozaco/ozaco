import { createServer } from 'server:core'
import { attempt, run, sleep } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { OtlpExporter, toCamelDeep } from 'server:plugins/observe/otlp'

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
              batch: { ms: 20 },
              metrics: { intervalMs: 30 },
              resource: { 'deployment.environment': 'test' },
            }),
          ],
        })
        yield* server.listen()
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
