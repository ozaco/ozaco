/**
 * Every logger entry is stamped with the span it was logged in (`Entry.trace`), read from
 * std:trace `ActiveSpan` — recording, non-recording or a pass-through inbound context — and the
 * JSON / pretty console forms carry it.
 */
import type { Operation } from 'std:effect'
import { attempt, run, spawn } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { fail, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import {
  ActiveSpan,
  current,
  enableTracing,
  parseTraceparent,
  passThrough,
  span,
  suppressed,
  Tracer,
} from 'std:trace'

import { describe, expect, it, spyOn } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'
import { ConsoleTransport } from 'std:logger/transport/console'

import { prettyFormat } from '../../src/logger/transport/console/internal'
import { memoryTracer } from '../trace/helpers'

import { captureTransport, createSink } from './helpers'

const INBOUND = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/** Run `body` with tracing on (an in-memory Tracer), a Logger and a capturing transport. */
const logged = async <T>(
  body: () => Operation<T>,
): Promise<{ entries: LoggerDef.Entry[]; value: T }> => {
  const sink = createSink()
  const tracer = memoryTracer()

  const value = unwrap(
    await run(function* () {
      yield* tracer.plugin.use()
      yield* DefaultLogger.use({ level: LogLevel.trace, timestamp: () => 1000 })
      yield* captureTransport('capture', sink).use()
      return yield* body()
    }),
  )

  return { entries: sink.entries, value }
}

describe('logger — trace correlation', () => {
  it('an entry inside span() carries its ids; one outside carries none', async () => {
    const { entries, value } = await logged(function* () {
      yield* Logger.actions.info('before')
      const context = yield* span('handler', function* (handle) {
        yield* Logger.actions.info('inside')
        return handle.context
      })
      yield* Logger.actions.info('after')
      return context
    })

    expect(entries.map(entry => [entry.msg, entry.trace])).toEqual([
      ['before', undefined],
      ['inside', { traceId: value.traceId, spanId: value.spanId, flags: value.flags }],
      ['after', undefined],
    ])
    expect('trace' in entries[0]!).toBe(false)
  })

  it('the innermost span wins, and a task forked inside a span logs with it', async () => {
    const { entries, value } = await logged(function* () {
      return yield* span('outer', function* () {
        return yield* span('inner', function* (inner) {
          const task = yield* spawn(() => Logger.actions.info('forked'))
          yield* task
          yield* Logger.actions.info('direct')
          return inner.context.spanId
        })
      })
    })

    expect(entries.map(entry => entry.trace?.spanId)).toEqual([value, value])
  })

  it('a non-recording (unsampled) span still stamps its ids, flags without the sampled bit', async () => {
    const { entries, value } = await logged(() =>
      span('poll', { sampled: false }, function* (handle) {
        yield* Logger.actions.debug('polling')
        return handle.context
      }),
    )

    expect(entries[0]?.trace).toEqual({ traceId: value.traceId, spanId: value.spanId, flags: 2 })
  })

  it('tracing off: a pass-through inbound context still correlates the entry', async () => {
    const sink = createSink()
    const inbound = parseTraceparent(INBOUND)!

    unwrap(
      await run(function* () {
        yield* enableTracing(false)
        yield* DefaultLogger.use()
        yield* captureTransport('capture', sink).use()
        yield* ActiveSpan.with(passThrough(inbound), () => Logger.actions.info('relayed'))
      }),
    )

    expect(sink.entries[0]?.trace).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      flags: 1,
    })
  })

  it('suppressed telemetry code still correlates its entries (activeContext)', async () => {
    const { entries, value } = await logged(() =>
      span('export', function* () {
        const { context } = yield* current()
        yield* suppressed(() => Logger.actions.warn('delivery slow'))
        return context
      }),
    )

    expect(entries[0]?.trace?.spanId).toBe(value.spanId)
  })

  it('without std:trace set up at all the entry has no trace', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* DefaultLogger.use()
        yield* captureTransport('capture', sink).use()
        yield* Logger.actions.info('plain')
      }),
    )

    expect(sink.entries[0]?.trace).toBeUndefined()
  })
})

describe('logger — correlated output', () => {
  it('JSON records carry trace_id / span_id / trace_flags', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {})

    try {
      const { value } = await logged(function* () {
        yield* JsonCodec.use()
        yield* ConsoleTransport.use({ pretty: false })

        return yield* span('handler', function* (handle) {
          yield* Logger.actions.info('inside', { n: 1 })
          return handle.context
        })
      })

      expect(JSON.parse(infoSpy.mock.calls[0]?.[0] as string)).toEqual({
        level: LogLevel.info,
        time: 1000,
        msg: 'inside',
        trace_id: value.traceId,
        span_id: value.spanId,
        trace_flags: '03',
        n: 1,
      })
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('pretty lines show `trace=<first 8>` and indent the failure chains below', async () => {
    const inner = fail('db.down', 'connection refused')
    const outer = fail('todo.save', 'saving failed', 'todos.create', inner)

    const outcome = await run(function* () {
      yield* JsonCodec.use()

      const base: LoggerDef.Entry = {
        level: LogLevel.error,
        time: 0,
        msg: 'request failed',
        error: '',
        failures: [],
        bindings: {},
        data: undefined,
      }

      return {
        simple: yield* prettyFormat(
          {
            ...base,
            error: 'app.x: boom',
            failures: [fail('app.x', 'boom')],
            trace: {
              traceId: '0af7651916cd43dd8448eb211c80319c',
              spanId: 'b'.repeat(16),
              flags: 1,
            },
          },
          false,
        ),
        chained: yield* prettyFormat(
          {
            ...base,
            error: 'todo.save: saving failed: todos.create',
            failures: [outer, fail('x')],
          },
          false,
        ),
      }
    })

    expect(unwrap(outcome)).toEqual({
      // a one-line failure is not repeated below the line
      simple: '[1970-01-01T00:00:00.000Z] ERROR trace=0af76519: request failed err="app.x: boom"',
      // a failure with a chain block is NOT also inline (`err=`): every failure prints once
      chained: [
        '[1970-01-01T00:00:00.000Z] ERROR: request failed',
        '  todo.save: saving failed',
        '      at todos.create',
        '  Caused by: db.down: connection refused',
        '  x',
      ].join('\n'),
    })
  })
})

describe('logger — exception records forwarded by a Tracer', () => {
  /** A Tracer that shows every exception record in the std Logger (as a server node does). */
  const forwardingTracer = () =>
    Tracer.implement({
      name: 'test/forwarding-tracer',
      version: '1.0.0',
      *setup() {
        yield* enableTracing()
        return {}
      },
    }).build({
      *export() {},
      *emit(log: TraceDef.LogData) {
        if (typeof log.attributes['exception.type'] === 'string') {
          yield* Logger.actions.error(log.eventName ?? 'exception', log.body)
        }
      },
    })

  it("carry the record's own span — `trace=<8>` on the pretty line — not the span active where it settled", async () => {
    const sink = createSink()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* forwardingTracer().use()
      yield* DefaultLogger.use({ level: LogLevel.trace, timestamp: () => 0 })
      yield* captureTransport('capture', sink).use()

      // a root span: the failure settles once it ended, where no span is active any more
      let root: TraceDef.SpanContext | undefined
      yield* attempt(() =>
        span('dispatch', function* (handle) {
          root = handle.context
          return yield* fail('app.boom', 'kaput')
        }),
      )

      const [entry] = sink.entries
      return { root: root!, entry: entry!, line: yield* prettyFormat(entry!, false) }
    })

    const { root, entry, line } = unwrap(outcome)

    expect(sink.entries).toHaveLength(1)
    expect(entry.trace).toEqual({ traceId: root.traceId, spanId: root.spanId, flags: root.flags })
    expect(line).toStartWith(
      `[1970-01-01T00:00:00.000Z] ERROR trace=${root.traceId.slice(0, 8)}: exception`,
    )
  })
})
