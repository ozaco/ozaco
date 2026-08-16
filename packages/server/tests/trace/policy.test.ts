import { Broker, defineAction, defineService } from 'server:core'
import { attempt } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { DefaultTracer, MemoryExporter, TracingPolicy } from 'server:plugin/trace'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const fixture = () =>
  defineService({
    name: 'svc',
    actions: {
      ok: defineAction(function* () {
        return 1
      }),
      broken: defineAction(function* () {
        return yield* fail('svc.broken', 'kaput')
      }),
    },
  })

describe('tracing policy', () => {
  it('wraps every dispatch in a client span carrying the correlation spine', async () => {
    const { spans, brokenRaised } = await runScoped(function* () {
      const service = fixture()

      yield* bootstrap()
      yield* install(MemoryExporter)
      yield* install(DefaultTracer)
      yield* install(TracingPolicy)
      yield* Broker.actions.register(service)

      yield* Broker.actions.call(service, 'ok', undefined)

      const broken = yield* attempt(() => Broker.actions.call(service, 'broken', undefined))

      yield* DefaultTracer.actions.flush()

      const drained = yield* MemoryExporter.actions.drain()

      return { spans: drained, brokenRaised: isFailure(broken) }
    })

    expect(brokenRaised).toBe(true)
    expect(spans.map(span => span.name).toSorted()).toEqual(['svc.broken', 'svc.ok'])

    for (const span of spans) {
      expect(span.kind).toBe('client')
      expect(String(span.attributes['ozaco.request_id'])).toMatch(/^r_/u)
      expect(String(span.attributes['ozaco.action_id'])).toMatch(/^a_/u)
      expect(span.attributes['ozaco.lane']).toBe('svc')
      expect(span.attributes['rpc.system']).toBe('ozaco-broker')
      expect(span.attributes['rpc.service']).toBe('svc')
      expect(typeof span.attributes['ozaco.service_id']).toBe('string')
    }

    const okSpan = spans.find(span => span.name === 'svc.ok')!
    const errorSpan = spans.find(span => span.name === 'svc.broken')!

    expect(okSpan.status).toBe('ok')
    expect(okSpan.attributes['rpc.method']).toBe('ok')
    expect(errorSpan.status).toBe('error')
    expect(errorSpan.attributes['otel.status_description']).toBe('kaput')
    expect(errorSpan.events.length).toBeGreaterThan(0)
    expect(errorSpan.events[0]!.message).toBe('kaput')
  })

  it('passes through when no tracer is installed, caching the probe', async () => {
    const values = await runScoped(function* () {
      const service = fixture()

      yield* bootstrap()
      yield* install(TracingPolicy)
      yield* Broker.actions.register(service)

      const first = yield* Broker.actions.call(service, 'ok', undefined)
      // second call exercises the cached `available: false` fast path
      const second = yield* Broker.actions.call(service, 'ok', undefined)
      const broken = yield* attempt(() => Broker.actions.call(service, 'broken', undefined))

      return { first, second, brokenRaised: isFailure(broken) }
    })

    expect(values.first).toBe(1)
    expect(values.second).toBe(1)
    expect(values.brokenRaised).toBe(true)
  })
})
