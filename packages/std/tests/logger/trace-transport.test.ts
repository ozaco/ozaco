/**
 * `TraceTransport` (`std:logger/transport/trace`): Logger entries → std:trace log records, checked
 * against an in-memory Trace sink.
 */
import type { Operation } from 'std:effect'
import { attempt, run } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { fail, isFailure, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { severityOf, TraceTransport } from 'std:logger/transport/trace'

import pkg from '../../package.json'
import { backendKey, isReservedLogKey } from '../../src/logger/internal/keys'
import { isRecordedIn } from '../../src/trace/internal/registry'
import type { MemoryTracer } from '../trace/helpers'
import { memoryTracer } from '../trace/helpers'

/** Tracing on (in-memory Trace sink), a Logger at `level` and the TraceTransport; runs `body`. */
const bridged = async <T>(
  body: (tracer: MemoryTracer) => Operation<T>,
  options: LoggerDef.Options = {},
): Promise<{ tracer: MemoryTracer; value: T }> => {
  const tracer = memoryTracer()

  const value = unwrap(
    await run(function* () {
      yield* tracer.plugin.use()
      yield* DefaultLogger.use({ level: LogLevel.trace, timestamp: () => 4242, ...options })
      yield* TraceTransport.use()

      return yield* body(tracer)
    }),
  )

  return { tracer, value }
}

/** The records that are logger lines (not exception records). */
const lines = (tracer: MemoryTracer): TraceDef.LogData[] =>
  tracer.logs.filter(log => log.attributes['exception.type'] === undefined)

describe('TraceTransport — mapping', () => {
  it('severity by level range (TRACE 1 … FATAL 21), severityText the range name', async () => {
    const { tracer } = await bridged(function* () {
      yield* Logger.actions.trace('t')
      yield* Logger.actions.debug('d')
      yield* Logger.actions.info('i')
      yield* Logger.actions.warn('w')
      yield* Logger.actions.error('e')
      yield* Logger.actions.fatal('f')
      yield* Logger.actions.log(35 as LogLevel, 'between info and warn')
    })

    expect(tracer.logs.map(log => [log.body, log.severityNumber, log.severityText])).toEqual([
      ['t', 1, 'TRACE'],
      ['d', 5, 'DEBUG'],
      ['i', 9, 'INFO'],
      ['w', 13, 'WARN'],
      ['e', 17, 'ERROR'],
      ['f', 21, 'FATAL'],
      ['between info and warn', 9, 'INFO'],
    ])
    expect(severityOf(0 as LogLevel)).toEqual({ number: 1, text: 'TRACE' })
  })

  it('a record carries the entry time, no event name, and the default logger scope', async () => {
    const { tracer } = await bridged(function* () {
      yield* Logger.actions.info('hello', { n: 1 })
    })

    const [log] = tracer.logs

    expect(log).toMatchObject({
      time: 4242,
      body: 'hello',
      attributes: { n: 1 },
      droppedAttributes: 0,
      context: null,
      service: null,
      scope: { name: '@ozaco/std/logger', version: pkg.version },
    })
    expect(log?.eventName).toBeUndefined()
  })

  it('body: the message, else the failure one-liner, else the level name — never empty', async () => {
    const { tracer } = await bridged(function* () {
      yield* Logger.actions.info('with message')
      yield* Logger.actions.debug(fail('app.flaky', 'retrying'))
      yield* Logger.actions.info({ only: 'data' })
    })

    expect(tracer.logs.map(log => log.body)).toEqual([
      'with message',
      'app.flaky: retrying',
      'INFO',
    ])
  })

  it('bindings + data are flattened to dotted leaves; data wins over a binding', async () => {
    const { tracer } = await bridged(function* () {
      yield* Logger.actions.child({ req: 'r-1', shared: 'binding' }, () =>
        Logger.actions.info('saved', {
          shared: 'data',
          user: { id: 1, roles: ['admin', 'dev'] },
          deep: { a: { b: { c: { d: 1 } } } },
          rows: [{ id: 1 }],
          when: new Date(0),
          nothing: null,
        }),
      )
    })

    expect(tracer.logs[0]?.attributes).toEqual({
      req: 'r-1',
      shared: 'data',
      'user.id': 1,
      'user.roles': ['admin', 'dev'],
      'deep.a.b.c': '{"d":1}',
      rows: '[{"id":1}]',
      when: '1970-01-01T00:00:00.000Z',
    })
  })

  it('non-finite numbers become their strings — in leaves, bindings and the overflow JSON', async () => {
    const wide: Record<string, unknown> = {}

    for (let index = 0; index < 64; index += 1) {
      wide[`k${index}`] = index
    }

    const { tracer } = await bridged(function* () {
      yield* Logger.actions.child({ bound: Number.NEGATIVE_INFINITY }, () =>
        Logger.actions.info('ratio', {
          ratio: 0 / 0,
          max: Number.POSITIVE_INFINITY,
          series: [1, Number.NaN],
          nested: { min: Number.NEGATIVE_INFINITY },
        }),
      )
      yield* Logger.actions.info('wide', { ...wide, late: Number.NaN })
    })

    const [ratio, overflow] = tracer.logs

    expect(ratio?.attributes).toEqual({
      bound: '-Infinity',
      ratio: 'NaN',
      max: 'Infinity',
      series: ['1', 'NaN'],
      'nested.min': '-Infinity',
    })
    // the leaf past 64 rides the overflow JSON as "NaN", never JSON's lossy null
    expect(JSON.parse(overflow?.attributes['ozaco.log.data'] as string)).toEqual({ late: 'NaN' })
  })

  it('keeps 64 leaves; the rest travel as ONE `ozaco.log.data` JSON string; values ≤ 8 KiB', async () => {
    const wide: Record<string, unknown> = {}

    for (let index = 0; index < 70; index += 1) {
      wide[`k${index}`] = index
    }

    const { tracer } = await bridged(function* () {
      yield* Logger.actions.info('wide', wide)
      yield* Logger.actions.info('long', { text: 'x'.repeat(10_000) })
    })

    const [wideLog, longLog] = tracer.logs
    const keys = Object.keys(wideLog?.attributes ?? {})

    expect(keys).toHaveLength(65)
    expect(keys.slice(0, 64)).toEqual(Array.from({ length: 64 }, (_, index) => `k${index}`))
    expect(JSON.parse(wideLog?.attributes['ozaco.log.data'] as string)).toEqual({
      k64: 64,
      k65: 65,
      k66: 66,
      k67: 67,
      k68: 68,
      k69: 69,
    })

    const text = longLog?.attributes['text'] as string

    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192)
    expect(text.endsWith('…')).toBe(true)
  })

  it('backend-reserved keys move to `ozaco.data.<key>` (compared lowercased, non-alnum ⇒ _)', async () => {
    const { tracer, value } = await bridged(() =>
      Trace.actions.span('handler', function* (handle) {
        yield* Logger.actions.info('collision test', {
          trace_id: 'user-supplied-trace',
          'Span-Id': 'user-span',
          severity_text: 'bogus',
          body: 'user-body',
          'service.name': 'bogus-svc',
          level: 'user-level',
          _timestamp: 1,
          o2_event_name: 'fake',
          service: { name: 'nested-bogus' },
          ok: true,
        })

        return handle.context
      }),
    )

    const [log] = lines(tracer)

    expect(log?.attributes).toEqual({
      'ozaco.data.trace_id': 'user-supplied-trace',
      'ozaco.data.Span-Id': 'user-span',
      'ozaco.data.severity_text': 'bogus',
      'ozaco.data.body': 'user-body',
      'ozaco.data.service.name': 'nested-bogus',
      'ozaco.data.level': 'user-level',
      'ozaco.data._timestamp': 1,
      'ozaco.data.o2_event_name': 'fake',
      ok: true,
    })
    // the record's own correlation / body are untouched
    expect(log?.context).toEqual({
      traceId: value.traceId,
      spanId: value.spanId,
      flags: value.flags,
    })
    expect(log?.body).toBe('collision test')
    expect(backendKey('Instrumentation.Library-Name')).toBe('instrumentation_library_name')
    expect([isReservedLogKey('Detected-Level'), isReservedLogKey('user.id')]).toEqual([true, false])
  })

  it('the `logger` binding becomes the scope name and is no attribute', async () => {
    const { tracer } = await bridged(function* () {
      yield* Logger.actions.child({ logger: 'todos', region: 'eu' }, () =>
        Logger.actions.info('creating todo'),
      )
      // a non-string `logger` binding names nothing: default scope, kept as an attribute
      yield* Logger.actions.child({ logger: 42 }, () => Logger.actions.info('odd'))
    })

    expect(tracer.logs.map(log => [log.scope, log.attributes])).toEqual([
      [{ name: 'todos' }, { region: 'eu' }],
      [{ name: '@ozaco/std/logger', version: pkg.version }, { logger: 42 }],
    ])
  })

  it('inside a span: the record is correlated to it and takes its service', async () => {
    const { tracer, value } = await bridged(() =>
      Trace.actions.span('todos.create', { service: 'todos' }, function* (handle) {
        yield* Logger.actions.info('inside')

        return handle.context
      }),
    )

    expect(tracer.logs[0]).toMatchObject({
      context: { traceId: value.traceId, spanId: value.spanId, flags: 3 },
      service: 'todos',
    })
  })
})

describe('TraceTransport — failures', () => {
  it('WARN+ inside a RECORDING span: recordFailure (span event + ONE exception record), the line plain', async () => {
    const failure = fail('todo.save', 'disk full', 'todos.create')

    const { tracer } = await bridged(function* () {
      yield* attempt(() =>
        Trace.actions.span('handler', function* () {
          yield* Logger.actions.error('saving failed', failure, { id: 7 })

          // the same failure escaping afterwards adds no second exception
          return yield* failure
        }),
      )
    })

    const exceptions = tracer.exceptions()

    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]).toMatchObject({
      severityNumber: 17,
      eventName: 'exception',
      attributes: {
        'exception.type': 'todo.save',
        'exception.message': 'disk full',
        'ozaco.failure.causes': ['todos.create'],
      },
    })

    const handler = tracer.span('handler')

    expect(handler.events.map(event => event.name)).toEqual(['exception'])
    expect(handler.status).toEqual({ code: 'error', message: 'disk full' })
    expect(exceptions[0]?.context?.spanId).toBe(handler.context.spanId)

    // the logger line itself: its message and data, no exception attributes
    expect(lines(tracer).map(log => [log.body, log.severityNumber, log.attributes])).toEqual([
      ['saving failed', 17, { id: 7 }],
    ])
  })

  it('a message-less, data-less failure line inside a recording span IS the exception record', async () => {
    const { tracer } = await bridged(() =>
      Trace.actions.span('handler', function* () {
        yield* Logger.actions.warn(fail('cache.miss', 'stale'))
      }),
    )

    expect(tracer.logs).toHaveLength(1)
    expect(tracer.exceptions()[0]).toMatchObject({ severityNumber: 13, body: 'cache.miss: stale' })
  })

  it('a failure already recorded in the trace: the line is emitted, without exception attributes', async () => {
    const failure = fail('app.kaput')

    const { tracer } = await bridged(() =>
      Trace.actions.span('handler', function* () {
        yield* Logger.actions.error(failure)
        yield* Logger.actions.error(failure)
      }),
    )

    expect(tracer.exceptions()).toHaveLength(1)
    expect(lines(tracer).map(log => log.body)).toEqual(['app.kaput'])
  })

  it('outside any span: the line carries the first failure’s exception attributes', async () => {
    const error = new TypeError('x is not a function')

    const { tracer } = await bridged(function* () {
      yield* Logger.actions.error('boot failed', error, fail('app.second'))
    })

    expect(tracer.logs).toHaveLength(1)
    expect(tracer.logs[0]).toMatchObject({
      body: 'boot failed',
      severityNumber: 17,
      context: null,
      attributes: {
        // folded by asFailure: the `std:result.unknown` tag, the Error's serialized text
        'exception.type': 'std:result.unknown',
        'exception.message': 'TypeError: x is not a function',
        'ozaco.failure.chain': ['std:result.unknown: TypeError: x is not a function'],
      },
    })
    expect(tracer.logs[0]?.attributes['exception.stacktrace']).toContain('TypeError')
  })

  it('a NON-recording span: exception attributes on the line, and the escape records no second one', async () => {
    const failure = fail('poll.failed', 'upstream 503')

    const { tracer, value } = await bridged(function* () {
      let traceId = ''

      yield* attempt(() =>
        Trace.actions.span('poll', { sampled: false }, function* (handle) {
          traceId = handle.context.traceId
          yield* Logger.actions.warn('poll failed', failure)

          return yield* failure
        }),
      )

      return traceId
    })

    expect(tracer.spans).toEqual([])
    expect(tracer.logs).toHaveLength(1)
    expect(tracer.logs[0]).toMatchObject({
      body: 'poll failed',
      severityNumber: 13,
      context: { traceId: value, flags: 2 },
      attributes: { 'exception.type': 'poll.failed' },
    })
    expect(isRecordedIn(failure, value)).toBe(true)
  })

  it('below WARN inside a recording span: exception attributes on the line, no span event', async () => {
    const failure = fail('app.retry', 'attempt 1')

    const { tracer } = await bridged(() =>
      Trace.actions.span('handler', function* () {
        yield* Logger.actions.info('retrying', failure)
      }),
    )

    expect(tracer.span('handler').events).toEqual([])
    expect(tracer.logs).toHaveLength(1)
    expect(tracer.logs[0]).toMatchObject({
      body: 'retrying',
      severityNumber: 9,
      attributes: { 'exception.type': 'app.retry' },
    })
  })

  it('a data key named like an exception attribute moves aside when the line carries one', async () => {
    const { tracer } = await bridged(function* () {
      yield* Logger.actions.error('x', fail('app.real'), { 'exception.type': 'user-type' })
    })

    expect(tracer.logs[0]?.attributes).toMatchObject({
      'exception.type': 'app.real',
      'ozaco.data.exception.type': 'user-type',
    })
  })
})

describe('TraceTransport — when it stays silent', () => {
  it('skips entries `ctx.log` already emitted (binding ozaco.telemetry = sent)', async () => {
    const { tracer } = await bridged(function* () {
      yield* Logger.actions.child({ 'ozaco.telemetry': 'sent' }, () =>
        Logger.actions.error('already emitted', fail('app.x')),
      )
      yield* Logger.actions.info('forwarded')
    })

    expect(tracer.logs.map(log => log.body)).toEqual(['forwarded'])
  })

  it('tracing off or suppressed: nothing is emitted', async () => {
    const { tracer } = await bridged(function* () {
      yield* Trace.actions.suppressed(() => Logger.actions.error('from inside an exporter'))
      yield* Trace.actions.enableTracing(false)
      yield* Logger.actions.error('tracing off')
    })

    expect(tracer.logs).toEqual([])
  })

  it('the level defaults to the Logger level at install; options.level overrides it', async () => {
    const outcome = await run(function* () {
      yield* DefaultLogger.use({ level: LogLevel.warn })

      const inherited = yield* TraceTransport.use()
      const explicit = yield* TraceTransport.use({ level: LogLevel.error })

      return [inherited.level, explicit.level]
    })

    expect(unwrap(outcome)).toEqual([LogLevel.warn, LogLevel.error])

    const { tracer } = await bridged(
      function* () {
        yield* Logger.actions.info('filtered by the Logger')
        yield* Logger.actions.warn('kept')
      },
      { level: LogLevel.warn },
    )

    expect(tracer.logs.map(log => log.body)).toEqual(['kept'])
  })

  it('without a Logger installed yet it forwards every level (the Logger filters first)', async () => {
    const outcome = await run(function* () {
      const ctx = yield* TraceTransport.use()

      return ctx.level
    })

    expect(unwrap(outcome)).toBe(LogLevel.trace)
  })

  it('a failing Trace sink never fails the log call', async () => {
    const broken = Trace.implement({
      name: 'test/broken-tracer',
      version: '1.0.0',
      *setup() {
        yield* Trace.actions.enableTracing()
      },
    }).build({
      *export() {},
      *emit() {
        return yield* fail('tracer.down', 'sink unavailable')
      },
    })

    const outcome = await run(function* () {
      yield* broken.use()
      yield* DefaultLogger.use()
      yield* TraceTransport.use()
      yield* Logger.actions.info('still fine')
      yield* Trace.actions.span('handler', () => Logger.actions.error('also fine', fail('app.x')))

      return 'done'
    })

    expect(isFailure(outcome)).toBe(false)
    expect(unwrap(outcome)).toBe('done')
  })
})
