/**
 * The process-level FALLBACK sink (`registerFallback`): where no scope Tracer records (tracing off
 * or never enabled, not suppressed) log records — `emitLog`, `event()`, `recordFailure` — go to
 * the FIRST registered sink; spans never do.
 */
import { run, spawn } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import {
  ActiveSpan,
  canEmit,
  current,
  emitLog,
  enableTracing,
  event,
  isRecorded,
  parseTraceparent,
  passThrough,
  recordFailure,
  registerFallback,
  span,
  startSpan,
  suppressed,
} from 'std:trace'

import { afterEach, describe, expect, it } from 'bun:test'

import pkg from '../../package.json'

import { memoryFallback, memoryTracer, withFallbacks } from './helpers'

const FALLBACK_KEY = Symbol.for('std:trace.fallback')

const queued = (): readonly TraceDef.FallbackSink[] =>
  ((globalThis as Record<symbol, unknown>)[FALLBACK_KEY] as
    | readonly TraceDef.FallbackSink[]
    | undefined) ?? []

const INBOUND = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/** Emit one plain record with `body` where it runs. */
const say = (body: string) => emitLog({ body, severityNumber: 9 })

afterEach(() => {
  // every test unregisters what it registered: the queue is process-wide
  expect(queued()).toEqual([])
})

describe('fallback registry', () => {
  it('first registered wins; later ones queue and take over, in order, as the first leaves', async () => {
    const first = memoryFallback('first')
    const second = memoryFallback('second')
    const third = memoryFallback('third')

    const releaseFirst = first.register()
    const releaseSecond = second.register()
    const releaseThird = third.register()

    try {
      expect(queued().map(sink => sink.id)).toEqual(['first', 'second', 'third'])
      unwrap(await run(() => say('one')))

      releaseFirst()
      unwrap(await run(() => say('two')))

      // a queued (not active) one leaving disturbs nobody
      releaseThird()
      unwrap(await run(() => say('three')))

      releaseSecond()
      unwrap(await run(() => say('nobody')))
    } finally {
      releaseFirst()
      releaseSecond()
      releaseThird()
    }

    expect(first.logs.map(log => log.body)).toEqual(['one'])
    expect(second.logs.map(log => log.body)).toEqual(['two', 'three'])
    expect(third.logs).toEqual([])
  })

  it('unregister is idempotent; the same sink registered twice leaves as two', async () => {
    const shared = memoryFallback('shared')
    const other = memoryFallback('other')

    const releaseA = shared.register()
    const releaseOther = other.register()
    const releaseB = shared.register()

    try {
      releaseA()
      releaseA()
      // `releaseA` twice took out only its own entry: `other` is first now, `shared` still queued
      expect(queued().map(sink => sink.id)).toEqual(['other', 'shared'])

      releaseOther()
      unwrap(await run(() => say('to the second registration')))
      expect(shared.logs.map(log => log.body)).toEqual(['to the second registration'])
    } finally {
      releaseA()
      releaseOther()
      releaseB()
    }
  })

  it('lives on globalThis under Symbol.for("std:trace.fallback") (one queue per process)', async () => {
    const fallback = memoryFallback('global')

    await withFallbacks([fallback], () => {
      const [entry] = queued()
      expect(entry?.id).toBe('global')
      expect(Object.isFrozen(queued())).toBe(true)
    })

    expect(queued()).toEqual([])
  })

  it('nothing registered: every entry point is a no-op, canEmit() is false', async () => {
    const seen = unwrap(
      await run(function* () {
        const before = yield* canEmit()
        yield* say('dropped')
        yield* event('dropped')
        yield* recordFailure(fail('app.dropped'))
        yield* (yield* current()).recordFailure(fail('app.dropped'))
        return before
      }),
    )

    expect(seen).toBe(false)
  })
})

describe('fallback routing', () => {
  it('tracing never enabled: emitLog goes to the fallback, uncorrelated', async () => {
    const fallback = memoryFallback()

    await withFallbacks([fallback], async () => {
      const can = unwrap(
        await run(function* () {
          yield* emitLog({
            body: 'bus gap',
            severityNumber: 13,
            severityText: 'WARN',
            attributes: { 'ozaco.db.bus.seq': 7 },
            scope: { name: '@ozaco/db' },
            time: 1234,
          })
          return yield* canEmit()
        }),
      )

      expect(can).toBe(true)
    })

    expect(fallback.logs).toEqual([
      {
        time: 1234,
        observedTime: expect.any(Number),
        severityNumber: 13,
        severityText: 'WARN',
        body: 'bus gap',
        attributes: { 'ozaco.db.bus.seq': 7 },
        droppedAttributes: 0,
        context: null,
        service: null,
        scope: { name: '@ozaco/db' },
      },
    ])
    // the sink runs suppressed: its own work can never recurse into telemetry
    expect(fallback.suppressedWhileEmitting).toEqual([true])
  })

  it('tracing ON: the scope Tracer gets the record, the fallback nothing', async () => {
    const fallback = memoryFallback()
    const tracer = memoryTracer()

    await withFallbacks([fallback], async () => {
      unwrap(
        await run(function* () {
          yield* tracer.plugin.use()
          yield* say('traced')
          yield* span('handler', () => say('in a span'))
        }),
      )
    })

    expect(tracer.logs.map(log => log.body)).toEqual(['traced', 'in a span'])
    expect(fallback.logs).toEqual([])
  })

  it('tracing explicitly OFF (a Tracer installed, switched off): the fallback gets it', async () => {
    const fallback = memoryFallback()
    const tracer = memoryTracer()

    await withFallbacks([fallback], async () => {
      unwrap(
        await run(function* () {
          yield* tracer.plugin.use()
          yield* enableTracing(false)
          yield* say('switched off')
        }),
      )
    })

    expect(tracer.logs).toEqual([])
    expect(fallback.logs.map(log => log.body)).toEqual(['switched off'])
  })

  it('suppressed: nothing — neither the Tracer nor the fallback', async () => {
    const fallback = memoryFallback()

    await withFallbacks([fallback], async () => {
      const can = unwrap(
        await run(() =>
          suppressed(function* () {
            yield* say('from inside an exporter')
            yield* event('ignored')
            yield* recordFailure(fail('app.ignored'))
            return yield* canEmit()
          }),
        ),
      )

      expect(can).toBe(false)
    })

    expect(fallback.logs).toEqual([])
  })

  it('a pass-through context is the record’s context (ids + flags)', async () => {
    const fallback = memoryFallback()
    const inbound = parseTraceparent(INBOUND)!

    await withFallbacks([fallback], async () => {
      unwrap(await run(() => ActiveSpan.with(passThrough(inbound), () => say('carried'))))
    })

    expect(fallback.logs[0]?.context).toEqual({
      traceId: inbound.traceId,
      spanId: inbound.spanId,
      flags: 1,
    })
    expect(fallback.logs[0]?.scope).toEqual({ name: '@ozaco/std', version: pkg.version })
  })

  it('an outer traced span seen from a tracing-OFF scope: correlated to it, never written to', async () => {
    const fallback = memoryFallback()

    const { tracer, outer } = await withFallbacks([fallback], async () => {
      const inner = memoryTracer()
      const spanId = unwrap(
        await run(function* () {
          yield* inner.plugin.use()

          return yield* span('outer', { service: 'billing' }, function* (handle) {
            const task = yield* spawn(function* () {
              yield* enableTracing(false)
              yield* event('from.off', { n: 1 })
              yield* recordFailure(fail('app.off', 'failed off-scope'))
            })
            yield* task
            return handle.context.spanId
          })
        }),
      )

      return { tracer: inner, outer: spanId }
    })

    expect(fallback.logs.map(log => [log.eventName, log.context?.spanId, log.service])).toEqual([
      ['from.off', outer, 'billing'],
      ['exception', outer, 'billing'],
    ])
    // the span itself stays untouched: no event, no exception event, status unset
    const data = tracer.span('outer')
    expect(data.events).toEqual([])
    expect(data.status.code).toBe('unset')
    expect(tracer.logs).toEqual([])
  })

  it('spans never reach the fallback', async () => {
    const fallback = memoryFallback()

    await withFallbacks([fallback], async () => {
      unwrap(
        await run(function* () {
          yield* span('untraced', function* () {})
          const live = yield* startSpan('live')
          yield* live.end({ failure: fail('app.live') })
        }),
      )
    })

    expect(fallback.logs).toEqual([])
  })

  it('a failing sink never fails the caller', async () => {
    const releaseBroken = registerFallback({
      id: 'broken',
      *emit() {
        return yield* fail('sink.down', 'unavailable')
      },
    })

    try {
      const outcome = await run(function* () {
        yield* say('still fine')
        yield* event('also fine')
        yield* recordFailure(fail('app.x'))
        return 'done'
      })

      expect(isFailure(outcome)).toBe(false)
      expect(unwrap(outcome)).toBe('done')
    } finally {
      releaseBroken()
    }
  })
})

describe('fallback — event() and recordFailure()', () => {
  it('event(): the record only (event name, INFO default, otel.event.name)', async () => {
    const fallback = memoryFallback()

    await withFallbacks([fallback], async () => {
      unwrap(
        await run(function* () {
          yield* event('cache.miss', { key: 'k' })
          yield* event('cache.evicted', { key: 'k' }, { severity: 13, body: 'evicted k', time: 5 })
        }),
      )
    })

    expect(fallback.logs).toMatchObject([
      {
        eventName: 'cache.miss',
        body: 'cache.miss',
        severityNumber: 9,
        attributes: { key: 'k', 'otel.event.name': 'cache.miss' },
        context: null,
      },
      { eventName: 'cache.evicted', body: 'evicted k', severityNumber: 13, time: 5 },
    ])
  })

  it('recordFailure(): ONE exception record per (failure, trace), with its chain', async () => {
    const fallback = memoryFallback()
    const failure = fail('app.boom', 'it broke')

    await withFallbacks([fallback], async () => {
      unwrap(
        await run(function* () {
          yield* recordFailure(failure)
          yield* recordFailure(failure)
          yield* (yield* current()).recordFailure(failure)
          yield* recordFailure(fail('app.handled', 'dealt with'), { handled: true })
          yield* recordFailure(fail('app.named'), { eventName: 'ozaco.custom', severity: 21 })
        }),
      )
    })

    expect(
      fallback.logs.map(log => [
        log.eventName,
        log.severityNumber,
        log.attributes['exception.type'],
      ]),
    ).toEqual([
      ['exception', 17, 'app.boom'],
      ['exception', 13, 'app.handled'],
      ['ozaco.custom', 21, 'app.named'],
    ])
    expect(fallback.logs[0]).toMatchObject({
      body: 'app.boom: it broke',
      context: null,
      attributes: {
        'exception.message': 'it broke',
        'ozaco.failure.chain': ['app.boom: it broke'],
      },
    })
    // recorded "outside any trace": a later escape into the same (absent) trace adds nothing
    expect(isRecorded(failure, '')).toBe(true)
  })
})
