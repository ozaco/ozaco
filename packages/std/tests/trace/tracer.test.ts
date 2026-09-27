import { run } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import {
  emitLog,
  enableTracing,
  event,
  isTracing,
  span,
  TraceErrors,
  traceNow,
  Tracer,
  TraceSeverity,
} from 'std:trace'

import { describe, expect, it } from 'bun:test'

import pkg from '../../package.json'

import { memoryTracer, traced } from './helpers'

const failingTracer = (how: 'throw' | 'fail') =>
  Tracer.implement({
    name: `test/failing-tracer-${how}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
    },
  }).build({
    *export() {
      if (how === 'throw') {
        throw new Error('exporter crashed')
      }
      return yield* fail('test.export', 'rejected')
    },
    *emit() {
      return yield* fail('test.emit', 'rejected')
    },
  })

describe('Tracer protocol', () => {
  it('fans every span and record out to EVERY install', async () => {
    const first = memoryTracer()
    const second = memoryTracer()

    unwrap(
      await run(function* () {
        yield* first.plugin.use()
        yield* second.plugin.use()
        yield* span('both', () => event('ozaco.seen'))
      }),
    )

    for (const tracer of [first, second]) {
      expect(tracer.names()).toBe('both')
      expect(tracer.logs.map(log => log.eventName)).toEqual(['ozaco.seen'])
    }
  })

  it('a failing install never fails the traced code nor starves the others', async () => {
    const tracer = memoryTracer()

    const value = unwrap(
      await run(function* () {
        yield* failingTracer('throw').use()
        yield* failingTracer('fail').use()
        yield* tracer.plugin.use()
        return yield* span('survives', function* () {
          yield* event('ozaco.step')
          return 'ok'
        })
      }),
    )

    expect(value).toBe('ok')
    expect(tracer.names()).toBe('survives')
    expect(tracer.logs).toHaveLength(1)
  })

  it('a direct call sees the first failure, tagged TraceErrors.Tracer, after all ran', async () => {
    const tracer = memoryTracer()

    const outcome = await run(function* () {
      yield* failingTracer('fail').use()
      yield* tracer.plugin.use()
      return yield* Tracer.actions.emit({
        time: 0,
        observedTime: 0,
        severityNumber: 9,
        body: 'direct',
        attributes: {},
        droppedAttributes: 0,
        context: null,
        service: null,
        scope: { name: 'test' },
      })
    })

    expect(isFailure(outcome)).toBe(true)
    expect(outcome).toMatchObject({ error: TraceErrors.Tracer })
    // the tracer's own failure is nested in the TraceErrors.Tracer one; each carries the plugin
    // runtime labels of the hops it crossed — the impl action's on the inner one, the dispatch's
    // on the outer one
    expect((outcome as { causes?: unknown[] }).causes).toEqual([
      expect.objectContaining({
        error: 'test.emit',
        message: 'rejected',
        causes: ['emit', 'test/failing-tracer-fail@1.0.0'],
      }),
      'dispatch',
      `std/tracer@${pkg.version}`,
    ])
    expect(tracer.logs.map(log => log.body)).toEqual(['direct'])
  })

  it('without an install the calls are no-ops', async () => {
    const outcome = await run(function* () {
      yield* enableTracing()
      return yield* span('nowhere', () => event('ozaco.lost'))
    })

    expect(isFailure(outcome)).toBe(false)
  })

  it('an exporter runs suppressed: its own spans / records never recurse', async () => {
    const seen: boolean[] = []
    const sink: TraceDef.SpanData[] = []

    const recursive = Tracer.implement({
      name: 'test/recursive-tracer',
      version: '1.0.0',
      *setup() {
        yield* enableTracing()
      },
    }).build({
      *export(data: TraceDef.SpanData) {
        seen.push(yield* isTracing())
        sink.push(data)
        yield* span('exporter-work', () => event('ozaco.exporting'))
      },
      *emit() {},
    })

    unwrap(
      await run(function* () {
        yield* recursive.use()
        yield* span('user', function* () {})
      }),
    )

    expect(seen).toEqual([false])
    expect(sink.map(data => data.name)).toEqual(['user'])
  })
})

describe('event()', () => {
  it('a span event on the active span AND a log record', async () => {
    const { tracer } = await traced(() =>
      span('dispatch', { service: 'todos', scope: { name: '@ozaco/server' } }, () =>
        event('ozaco.cache.evict', { 'ozaco.cache.tags': ['todos'] }),
      ),
    )

    const data = tracer.span('dispatch')
    const [spanEvent] = data.events
    expect(spanEvent).toMatchObject({
      name: 'ozaco.cache.evict',
      attributes: { 'ozaco.cache.tags': ['todos'] },
    })

    const [log] = tracer.logs
    expect(log).toMatchObject({
      severityNumber: TraceSeverity.info,
      body: 'ozaco.cache.evict',
      eventName: 'ozaco.cache.evict',
      attributes: { 'ozaco.cache.tags': ['todos'], 'otel.event.name': 'ozaco.cache.evict' },
      context: { traceId: data.context.traceId, spanId: data.context.spanId, flags: 3 },
      service: 'todos',
      scope: { name: '@ozaco/server' },
    })
    expect(log!.severityText).toBeUndefined()
    expect(log!.time).toBe(spanEvent!.time)
  })

  it('time / severity / body options', async () => {
    const { tracer } = await traced(() =>
      span('rtc', () =>
        event(
          'ozaco.rtc.ice',
          { 'ozaco.rtc.state': 'connected' },
          {
            time: 1234,
            severity: TraceSeverity.debug,
            body: 'ice connected',
          },
        ),
      ),
    )

    expect(tracer.span('rtc').events[0]!.time).toBe(1234)
    expect(tracer.logs[0]).toMatchObject({ time: 1234, severityNumber: 5, body: 'ice connected' })
  })

  it('outside any span: a record without context', async () => {
    const { tracer } = await traced(() => event('ozaco.boot'))
    expect(tracer.logs[0]).toMatchObject({ context: null, eventName: 'ozaco.boot' })
  })
})

describe('emitLog()', () => {
  it('fills context, service, scope and time from the active span', async () => {
    const { tracer } = await traced(() =>
      span('dispatch', { service: 'todos', scope: { name: '@ozaco/server' } }, () =>
        emitLog({
          body: 'created',
          severityNumber: TraceSeverity.info,
          severityText: 'info',
          attributes: { 'todo.id': 7, user: { id: 1 }, gone: undefined },
        }),
      ),
    )

    const data = tracer.span('dispatch')
    expect(tracer.logs[0]).toMatchObject({
      body: 'created',
      severityText: 'info',
      attributes: { 'todo.id': 7, 'user.id': 1 },
      context: { spanId: data.context.spanId },
      service: 'todos',
      scope: { name: '@ozaco/server' },
    })
    expect(tracer.logs[0]!.eventName).toBeUndefined()
    expect(tracer.logs[0]!.time).toBeGreaterThanOrEqual(data.start)
    expect(tracer.logs[0]!.observedTime).toBeGreaterThan(0)
  })

  it('explicit fields win; an empty body falls back to the event name', async () => {
    const { tracer } = await traced(() =>
      span('any', () =>
        emitLog({
          body: '',
          severityNumber: 9,
          eventName: 'ozaco.domain',
          context: null,
          service: 'billing',
          scope: { name: 'custom' },
          time: 5,
        }),
      ),
    )

    expect(tracer.logs[0]).toMatchObject({
      body: 'ozaco.domain',
      eventName: 'ozaco.domain',
      attributes: { 'otel.event.name': 'ozaco.domain' },
      context: null,
      service: 'billing',
      scope: { name: 'custom' },
      time: 5,
    })
  })

  it('log attribute values go up to 16 KiB (span values stop at 2 KiB)', async () => {
    const { tracer } = await traced(() =>
      emitLog({ body: 'big', severityNumber: 9, attributes: { payload: 'z'.repeat(20_000) } }),
    )

    const value = String(tracer.logs[0]!.attributes.payload)
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(16_384)
    expect(value.length).toBeGreaterThan(2048)
  })
})

describe('traceNow()', () => {
  it('the active local trace clock, else Date.now()', async () => {
    const { value } = await traced(function* () {
      const outside = yield* traceNow()
      const inside = yield* span('clock', () => traceNow())
      return { outside, inside }
    })

    expect(Math.abs(value.outside - Date.now())).toBeLessThan(1000)
    expect(Math.abs(value.inside - Date.now())).toBeLessThan(1000)
  })

  it('outside a trace: the clock a new root anchors to — a root started at it precedes its work', async () => {
    // a wall clock AHEAD of the process trace clock (still within the drift budget): a
    // `Date.now()` fallback would stamp the root after everything its body does
    const realNow = Date.now
    Date.now = () => realNow() + 400

    try {
      const { tracer } = await traced(function* () {
        const at = yield* traceNow()
        yield* span('receipt', { startTime: at }, function* () {
          yield* event('work')
        })
      })

      const root = tracer.span('receipt')
      expect(root.events[0]!.time).toBeGreaterThanOrEqual(root.start)
      expect(root.end).toBeGreaterThanOrEqual(root.start)
    } finally {
      Date.now = realNow
    }
  })
})
