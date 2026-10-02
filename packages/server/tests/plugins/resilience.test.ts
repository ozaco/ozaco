import { action, createServer, ServerErrors, service } from 'server:core'
import { Resilience } from 'server:plugins'
import { all, attempt, fork, race, run, sleep } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import { asFailure, fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { TraceTransport } from 'std:logger/transport/trace'
import { z } from 'zod'

import { storage } from '../helpers'

let installs = 0

/** An in-memory std:trace `Trace` sink installed around the server: every span and log record. */
const memoryTracer = () => {
  installs += 1

  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Trace.implement({
    name: `test/resilience-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* Trace.actions.enableTracing()

      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit(log: TraceDef.LogData) {
      logs.push(log)
    },
  })

  const named = (name: string): TraceDef.SpanData[] => spans.filter(data => data.name === name)
  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)
  const events = (name: string): TraceDef.LogData[] => logs.filter(log => log.eventName === name)

  return { plugin, spans, logs, named, exceptions, events }
}

const make = () => {
  const counters = {
    slow: 0,
    flaky: 0,
    fragile: 0,
    dedup: 0,
    once: 0,
    picky: 0,
    shared: 0,
    trips: 0,
  }
  const svc = service('r', {
    slow: action.query(
      { input: z.object({ ms: z.number() }), output: z.string(), timeoutMs: 80 },
      function* ({ input }) {
        counters.slow += 1
        yield* sleep(input.ms)

        return 'done'
      },
    ),
    flaky: action.query(
      { output: z.number(), retry: { times: 2, when: ['r.down'], delayMs: 1 } },
      function* () {
        counters.flaky += 1

        if (counters.flaky < 3) {
          return yield* fail('r.down', 'not yet')
        }

        return counters.flaky
      },
    ),
    fragile: action.query(
      { output: z.string(), breaker: { failures: 2, halfOpenMs: 100 } },
      function* () {
        counters.fragile += 1

        return yield* fail('r.broken', 'always')
      },
    ),
    narrow: action.query(
      { input: z.object({ ms: z.number() }), output: z.string(), bulkhead: { max: 1, queue: 1 } },
      function* ({ input }) {
        yield* sleep(input.ms)

        return 'ok'
      },
    ),
    dedup: action.query(
      { input: z.object({ k: z.string() }), output: z.number(), singleflight: true },
      function* () {
        counters.dedup += 1
        yield* sleep(30)

        return counters.dedup
      },
    ),
    limited: action.query(
      { output: z.string(), rateLimit: { limit: 2, windowMs: 60_000 } },
      function* () {
        return 'ok'
      },
    ),
    soft: action.query(
      {
        output: z.string(),
        *fallback(failure: AnyType) {
          return `fallback:${failure.error}`
        },
      },
      function* () {
        return yield* fail('r.nope', 'primary failed')
      },
    ),

    // --- telemetry fixtures ---
    once: action.query(
      { output: z.number(), retry: { times: 2, when: ['r.down'], delayMs: 1 } },
      function* () {
        counters.once += 1

        if (counters.once === 1) {
          return yield* fail('r.down', 'first attempt fails')
        }

        return counters.once
      },
    ),
    always: action.query(
      { output: z.number(), retry: { times: 2, when: ['r.down'], delayMs: 1 } },
      function* () {
        return yield* fail('r.down', 'down for good')
      },
    ),
    layered: action.query(
      {
        output: z.string(),
        *fallback() {
          return 'fallback'
        },
      },
      function* () {
        return yield* fail('r.nope', 'primary failed', asFailure(new TypeError('socket hang up')))
      },
    ),
    rethrown: action.query(
      {
        output: z.string(),
        *fallback(failure: AnyType) {
          return yield* failure
        },
      },
      function* () {
        return yield* fail('r.nope', 'primary failed, fallback gave up')
      },
    ),
    trips: action.query(
      { output: z.string(), breaker: { failures: 2, halfOpenMs: 60 } },
      function* () {
        counters.trips += 1

        return yield* fail('r.broken', 'always')
      },
    ),
    picky: action.query(
      { output: z.string(), breaker: { failures: 1 }, errors: { 'r.bad': 400 } },
      function* () {
        counters.picky += 1

        return yield* fail('r.bad', 'the caller asked badly')
      },
    ),
    shared: action.query(
      {
        input: z.object({ k: z.string(), fail: z.boolean().optional(), ms: z.number() }),
        output: z.number(),
        singleflight: true,
      },
      function* ({ input }) {
        counters.shared += 1

        const n = counters.shared

        yield* sleep(input.ms)

        if (input.fail) {
          return yield* fail('r.shared', 'the shared computation failed')
        }

        return n
      },
    ),
  })

  return { svc, counters }
}

describe('resilience', () => {
  it('timeout, retry, breaker, bulkhead, singleflight, rate limit and fallback as action options', async () => {
    const { svc, counters } = make()

    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })

        expect(yield* server.call(svc, 'slow', { ms: 10 })).toBe('done')

        const timedOut = yield* attempt(server.call(svc, 'slow', { ms: 500 }))

        expect((timedOut as AnyType).error).toBe(ServerErrors.TimeoutPending)
        expect((timedOut as AnyType).causes).toContain('server:resilience.timeout')

        expect(yield* server.call(svc, 'flaky')).toBe(3)

        for (let n = 0; n < 2; n += 1) {
          expect(((yield* attempt(server.call(svc, 'fragile'))) as AnyType).error).toBe('r.broken')
        }

        const open = yield* attempt(server.call(svc, 'fragile'))

        expect((open as AnyType).error).toBe(ServerErrors.Unavailable)
        expect(counters.fragile).toBe(2)
        yield* sleep(120)
        // half-open: one trial reaches the handler again
        yield* attempt(server.call(svc, 'fragile'))
        expect(counters.fragile).toBe(3)

        const results = yield* all([
          attempt(server.call(svc, 'narrow', { ms: 60 })),
          attempt(server.call(svc, 'narrow', { ms: 60 })),
          attempt(server.call(svc, 'narrow', { ms: 60 })),
        ])
        const tags = results.map(result => ((result as AnyType).error ?? 'ok') as string)

        expect(tags.filter(tag => tag === 'ok')).toHaveLength(2)
        expect(tags).toContain(ServerErrors.Unavailable)

        const deduped = yield* all([
          server.call(svc, 'dedup', { k: 'a' }),
          server.call(svc, 'dedup', { k: 'a' }),
          server.call(svc, 'dedup', { k: 'b' }),
        ])

        expect(counters.dedup).toBe(2)
        expect(deduped[0]).toBe(deduped[1])

        expect(yield* server.call(svc, 'limited')).toBe('ok')
        expect(yield* server.call(svc, 'limited')).toBe('ok')

        const limited = yield* attempt(server.call(svc, 'limited'))

        expect((limited as AnyType).error).toBe(ServerErrors.RateLimited)

        expect(yield* server.call(svc, 'soft')).toBe('fallback:r.nope')
      }),
    )
  })
})

describe('resilience — telemetry', () => {
  it('retry then success: attempt 1 inline (one WARN on the dispatch), attempt spans only ≥ 2', async () => {
    const tracer = memoryTracer()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })

        expect(yield* server.call(svc, 'once')).toBe(2)
      }),
    )

    const dispatch = tracer.named('r.once')[0]!

    expect(dispatch.status.code).toBe('unset')
    expect(dispatch.attributes['error.type']).toBeUndefined()
    expect(dispatch.events.map(event => event.name)).toEqual(['exception'])

    const attempts = tracer.named('resilience.attempt')

    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      kind: 'internal',
      scope: { name: '@ozaco/server/resilience' },
      status: { code: 'unset' },
      attributes: { 'ozaco.resilience.attempt': 2, 'ozaco.resilience.delay_ms': 1 },
    })
    expect(attempts[0]!.parent?.spanId).toBe(dispatch.context.spanId)

    const exceptions = tracer.exceptions()

    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]).toMatchObject({
      eventName: 'ozaco.action.exception',
      severityNumber: 13,
      attributes: { 'exception.type': 'r.down', 'exception.message': 'first attempt fails' },
    })
    expect(exceptions[0]!.context?.spanId).toBe(dispatch.context.spanId)
  })

  it('retries exhausted: every retried failure WARN, the last one by its status class', async () => {
    const tracer = memoryTracer()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })
        const outcome = yield* attempt(server.call(svc, 'always'))

        expect((outcome as AnyType).error).toBe('r.down')
      }),
    )

    const dispatch = tracer.named('r.always')[0]!
    const attempts = tracer.named('resilience.attempt')

    expect(attempts.map(data => data.attributes['ozaco.resilience.attempt'])).toEqual([2, 3])
    expect(attempts.map(data => data.attributes['ozaco.resilience.delay_ms'])).toEqual([1, 2])
    expect(dispatch.status.code).toBe('error')

    const exceptions = tracer.exceptions()

    expect(exceptions.map(log => log.severityNumber).toSorted()).toEqual([13, 13, 17])

    const onSpan = (spanId: string) => exceptions.find(log => log.context?.spanId === spanId)!

    expect(onSpan(dispatch.context.spanId).severityNumber).toBe(13)
    expect(onSpan(attempts[0]!.context.spanId).severityNumber).toBe(13)
    expect(onSpan(attempts[1]!.context.spanId).severityNumber).toBe(17)
  })

  it('fallback: the primary runs in an attempt span (its chain recorded WARN), fallback flagged', async () => {
    const tracer = memoryTracer()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })

        expect(yield* server.call(svc, 'layered')).toBe('fallback')
      }),
    )

    const dispatch = tracer.named('r.layered')[0]!
    const primary = tracer.named('resilience.attempt')[0]!

    expect(dispatch.status.code).toBe('unset')
    expect(dispatch.attributes['ozaco.resilience.fallback']).toBe(true)
    expect(primary.parent?.spanId).toBe(dispatch.context.spanId)
    expect(primary.attributes['error.type']).toBe('r.nope')

    const exceptions = tracer.exceptions()

    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]!.severityNumber).toBe(13)
    expect(exceptions[0]!.context?.spanId).toBe(primary.context.spanId)
    expect(exceptions[0]!.attributes['ozaco.failure.chain']).toEqual([
      'r.nope: primary failed',
      'std:result.unknown: TypeError: socket hang up',
    ])
  })

  it("fallback that re-raises: no flag, the primary failure recorded once as the call's ERROR", async () => {
    const tracer = memoryTracer()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })

        expect(((yield* attempt(server.call(svc, 'rethrown'))) as AnyType).error).toBe('r.nope')
      }),
    )

    const dispatch = tracer.named('r.rethrown')[0]!

    expect(dispatch.status.code).toBe('error')
    expect(dispatch.attributes['ozaco.resilience.fallback']).toBeUndefined()

    const exceptions = tracer.exceptions()

    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]!.severityNumber).toBe(17)
  })

  it('breaker: transitions are events, rejections link the tripping call, only 5xx count', async () => {
    const tracer = memoryTracer()
    const lines: LoggerDef.Entry[] = []
    const capture = LoggerTransport.implement({
      name: 'test/resilience-logger-capture',
      version: '1.0.0',
      *setup() {
        return { name: 'capture', level: LogLevel.trace }
      },
    }).build({
      *write(entry: LoggerDef.Entry) {
        lines.push(entry)
      },
      *flush() {},
      *close() {},
    })
    const { svc, counters } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        yield* DefaultLogger.use({ level: LogLevel.trace })
        yield* capture.use()
        yield* TraceTransport.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })

        for (let n = 0; n < 2; n += 1) {
          expect(((yield* attempt(server.call(svc, 'trips'))) as AnyType).error).toBe('r.broken')
        }

        const open = yield* attempt(server.call(svc, 'trips'))

        expect((open as AnyType).error).toBe(ServerErrors.Unavailable)
        expect(counters.trips).toBe(2)
        yield* sleep(80)
        // the half-open trial fails: open again
        yield* attempt(server.call(svc, 'trips'))
        expect(counters.trips).toBe(3)

        // client failures (4xx) never trip a circuit
        for (let n = 0; n < 3; n += 1) {
          expect(((yield* attempt(server.call(svc, 'picky'))) as AnyType).error).toBe('r.bad')
        }

        expect(counters.picky).toBe(3)
      }),
    )

    const calls = tracer.named('r.trips')

    expect(calls).toHaveLength(4)

    const [, tripping, rejected, trial] = calls

    const transitions = (data: TraceDef.SpanData) =>
      data.events
        .filter(event => event.name === 'breaker')
        .map(event => [
          event.attributes?.['ozaco.resilience.breaker.state.previous'],
          event.attributes?.['ozaco.resilience.breaker.state'],
        ])

    expect(transitions(tripping!)).toEqual([['closed', 'open']])
    expect(transitions(trial!)).toEqual([
      ['open', 'half_open'],
      ['half_open', 'open'],
    ])
    expect(transitions(rejected!)).toEqual([])

    // the fail-fast rejection links the call that tripped the circuit
    expect(rejected!.links).toHaveLength(1)
    expect(rejected!.links[0]!.context.spanId).toBe(tripping!.context.spanId)
    expect(rejected!.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'breaker.trip' })
    expect(rejected!.attributes['error.type']).toBe(ServerErrors.Unavailable)

    // each transition is also a log record: WARN when it opens
    expect(
      tracer
        .events('breaker')
        .map(log => [log.attributes['ozaco.resilience.breaker.state'], log.severityNumber]),
    ).toEqual([
      ['open', 13],
      ['half_open', 9],
      ['open', 13],
    ])

    // …and the same three lines in the terminal (WARN when it opens), the Logger's bridge making
    // no second record of them (`ozaco.telemetry = 'sent'`)
    const printed = lines.filter(entry => entry.bindings.logger === '@ozaco/server/resilience')

    expect(printed.map(entry => [entry.msg, entry.level])).toEqual([
      ['r.trips: circuit closed → open', LogLevel.warn],
      ['r.trips: circuit open → half_open', LogLevel.info],
      ['r.trips: circuit half_open → open', LogLevel.warn],
    ])
    expect(tracer.logs.filter(log => log.scope.name === '@ozaco/server/resilience')).toHaveLength(3)

    // …under the plugin's own scope (not the dispatch span's), correlated to that span
    for (const log of tracer.events('breaker')) {
      expect(log.scope.name).toBe('@ozaco/server/resilience')
      expect(log.attributes['otel.event.name']).toBe('breaker')
    }

    expect(tracer.events('breaker')[0]!.context?.spanId).toBe(tripping!.context.spanId)
    expect(tracer.named('r.picky').every(data => transitions(data).length === 0)).toBe(true)
  })

  it('bulkhead: a queued call waits in its own span; a halted waiter leaves the queue', async () => {
    const tracer = memoryTracer()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })

        const results = yield* all([
          attempt(server.call(svc, 'narrow', { ms: 40 })),
          attempt(server.call(svc, 'narrow', { ms: 40 })),
          attempt(server.call(svc, 'narrow', { ms: 40 })),
        ])
        const tags = results.map(result => ((result as AnyType).error ?? 'ok') as string)

        expect(tags.toSorted()).toEqual(['ok', 'ok', ServerErrors.Unavailable].toSorted())

        // A holds the slot; B queues and is halted; C can still queue behind A and gets through
        const a = yield* fork(() => server.call(svc, 'narrow', { ms: 40 }))

        yield* sleep(1)
        yield* race([server.call(svc, 'narrow', { ms: 40 }), sleep(5)])

        const c = yield* fork(() => attempt(server.call(svc, 'narrow', { ms: 1 })))

        expect(yield* a).toBe('ok')
        expect(yield* c).toMatchObject({ value: 'ok' })
      }),
    )

    const waits = tracer.named('resilience.bulkhead.wait')

    expect(waits).toHaveLength(3)

    const [queued, halted, behind] = waits.toSorted((left, right) => left.start - right.start)
    const parents = new Set(tracer.named('r.narrow').map(data => data.context.spanId))

    for (const wait of waits) {
      expect(wait.scope.name).toBe('@ozaco/server/resilience')
      expect(parents.has(wait.parent!.spanId)).toBe(true)
    }

    // the queued call waited for the first one's slot
    expect(queued!.end - queued!.start).toBeGreaterThan(20)
    expect(halted!.attributes['ozaco.cancelled']).toBe(true)
    expect(behind!.attributes['ozaco.cancelled']).toBeUndefined()
  })

  it('singleflight: followers link the leader and fail in their OWN trace', async () => {
    const tracer = memoryTracer()
    const { svc, counters } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })
        const outcomes = yield* all([
          attempt(server.call(svc, 'shared', { k: 'x', fail: true, ms: 20 })),
          attempt(server.call(svc, 'shared', { k: 'x', fail: true, ms: 20 })),
        ])

        expect(outcomes.map(outcome => (outcome as AnyType).error)).toEqual([
          'r.shared',
          'r.shared',
        ])
        expect(counters.shared).toBe(1)
      }),
    )

    const calls = tracer.named('r.shared')
    const leader = calls.find(
      data => data.attributes['ozaco.resilience.singleflight'] === 'leader',
    )!
    const follower = calls.find(
      data => data.attributes['ozaco.resilience.singleflight'] === 'follower',
    )!

    expect(follower.context.traceId).not.toBe(leader.context.traceId)
    expect(follower.links).toHaveLength(1)
    expect(follower.links[0]!.context.spanId).toBe(leader.context.spanId)
    expect(follower.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'singleflight' })

    // the one shared failure: recorded once in EACH trace
    const exceptions = tracer.exceptions()

    expect(exceptions).toHaveLength(2)
    expect(exceptions.map(log => log.context?.spanId).toSorted()).toEqual(
      [leader.context.spanId, follower.context.spanId].toSorted(),
    )

    for (const data of [leader, follower]) {
      expect(data.status.code).toBe('error')
    }
  })

  it('singleflight: a halted leader releases its followers (one of them leads)', async () => {
    const { svc, counters } = make()

    unwrap(
      await run(function* () {
        yield* storage()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })
        const leader = yield* fork(() =>
          race([server.call(svc, 'shared', { k: 'h', ms: 40 }), sleep(10)]),
        )

        yield* sleep(1)

        // without the release the follower would wait for the halted leader forever
        const follower = yield* fork(() =>
          race([
            server.call(svc, 'shared', { k: 'h', ms: 40 }),
            (function* () {
              yield* sleep(500)

              return -1
            })(),
          ]),
        )

        yield* leader
        expect(yield* follower).toBe(2)
        expect(counters.shared).toBe(2)
      }),
    )
  })

  it('rate limit and timeout budgets land on the dispatch span', async () => {
    const tracer = memoryTracer()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [svc], plugins: [Resilience] })

        for (let n = 0; n < 3; n += 1) {
          yield* attempt(server.call(svc, 'limited'))
        }

        yield* server.call(svc, 'slow', { ms: 1 })
      }),
    )

    expect(
      tracer
        .named('r.limited')
        .map(data => data.attributes['ozaco.resilience.rate_limit.remaining']),
    ).toEqual([1, 0, 0])
    expect(tracer.named('r.limited')[2]!.attributes['error.type']).toBe(ServerErrors.RateLimited)
    expect(tracer.named('r.slow')[0]!.attributes['ozaco.resilience.timeout_ms']).toBe(80)
  })
})
