/**
 * Payload normalization defects the observe review found (std logger): a bare `Error` payload was
 * dropped, `{ err: new Error() }` logged `"err":{}`, only the LAST failure survived, a user key
 * named like a record key overwrote it, and a Failure inside data dumped its internals.
 */
import type { Operation } from 'std:effect'
import { run } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { ResultErrors, fail, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { normalizePayload } from '../../src/logger/internal/normalize'
import { toRecord } from '../../src/logger/internal/serialize'
import { prettyFormat } from '../../src/logger/transport/console/internal'

import { captureTransport, createSink } from './helpers'

const capture = async (
  body: () => Operation<void>,
  options: LoggerDef.Options = {},
): Promise<LoggerDef.Entry[]> => {
  const sink = createSink()

  unwrap(
    await run(function* () {
      yield* DefaultLogger.use({ level: LogLevel.trace, ...options })
      yield* captureTransport('capture', sink).use()
      yield* body()
    }),
  )

  return sink.entries
}

describe('logger — Error payloads become failures', () => {
  it('a bare Error payload is the entry failure (it was dropped before), kept as its raw', async () => {
    const error = new TypeError('denied')

    const [entry] = await capture(function* () {
      yield* Logger.actions.error('dialing failed', error)
    })

    expect(entry?.msg).toBe('dialing failed')
    expect(entry?.error).toBe('std:result.unknown: TypeError: denied')
    expect(entry?.data).toBeUndefined()
    expect(entry?.failures).toHaveLength(1)
    // folded by asFailure: tagged, the Error itself kept as raw
    expect(entry?.failures[0]?.error).toBe(ResultErrors.Unknown)
    expect(entry?.failures[0]?.raw).toBe(error)
  })

  it('{ err: new Error() } is the entry failure, not `"err":{}` in data', async () => {
    const [entry] = await capture(function* () {
      yield* Logger.actions.error('request failed', { err: new Error('socket hang up'), id: 7 })
    })

    expect(entry?.error).toBe('std:result.unknown: Error: socket hang up')
    expect(entry?.data).toEqual({ id: 7 })
    expect(entry?.failures.map(failure => (failure.raw as Error).message)).toEqual([
      'socket hang up',
    ])
  })

  it('`error` and the configured errorKey lift the same way; an object holding only it is no data', async () => {
    const entries = await capture(
      function* () {
        yield* Logger.actions.warn({ error: new RangeError('too far') })
        yield* Logger.actions.warn({ problem: fail('app.bad', 'nope') })
      },
      { errorKey: 'problem' },
    )

    expect(entries.map(entry => [entry.error, entry.data])).toEqual([
      ['std:result.unknown: RangeError: too far', undefined],
      ['app.bad: nope', undefined],
    ])
  })

  it('a string under the error key is plain data (only Errors / Failures are lifted)', () => {
    expect(normalizePayload([{ err: 'not an error' }])).toEqual({
      msg: '',
      data: { err: 'not an error' },
      error: '',
      failures: [],
    })
  })
})

describe('logger — every failure is kept', () => {
  it('two failure payloads: both kept in payload order, `error` is the FIRST one', async () => {
    const first = fail('app.first', 'one')
    const second = fail('app.second', 'two')

    const [entry] = await capture(function* () {
      yield* Logger.actions.error('both', first, second)
    })

    expect(entry?.failures).toEqual([first, second])
    expect(entry?.error).toBe('app.first: one')
  })

  it('the same failure twice (or one Error folded twice) is one failure', async () => {
    const failure = fail('app.once')
    const error = new Error('same')

    const entries = await capture(function* () {
      yield* Logger.actions.error(failure, { err: failure })
      yield* Logger.actions.error(error, { nested: { again: error } })
    })

    expect(entries.map(entry => entry.failures.length)).toEqual([1, 1])
  })
})

describe('logger — nested failures render via formatFailure', () => {
  it('a Failure / Error inside data renders as its one-liner (no `_d` internals) and is collected', async () => {
    const outcome = fail('db.down', 'connection refused', 'pool.acquire')
    const payload = { outcome, deep: { list: [new RangeError('r')] }, keep: { n: 1 } }

    const [entry] = await capture(function* () {
      yield* Logger.actions.warn('retrying', payload)
    })

    expect(entry?.data).toEqual({
      outcome: 'db.down: connection refused: pool.acquire',
      deep: { list: ['std:result.unknown: RangeError: r'] },
      keep: { n: 1 },
    })
    expect(JSON.stringify(entry?.data)).not.toContain('_d')
    expect(entry?.failures.map(failure => failure.error)).toEqual(['db.down', ResultErrors.Unknown])
    expect(entry?.failures[1]?.raw).toBeInstanceOf(RangeError)
    expect(entry?.error).toBe('db.down: connection refused: pool.acquire')

    // copy on write: the caller's objects are untouched, an unchanged branch is reused as is
    expect(payload.outcome).toBe(outcome)
    expect(payload.deep.list[0]).toBeInstanceOf(RangeError)
    expect(entry?.data?.['keep']).toBe(payload.keep)
  })

  it('an array payload renders its failures too; a cycle does not hang', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic

    const arrays = normalizePayload(['items', [fail('app.x', 'y')] as never])
    expect(arrays.msg).toBe('items ["app.x: y"]')
    expect(arrays.failures).toHaveLength(1)

    const cycle = normalizePayload([{ cyclic }])
    expect(cycle.data?.['cyclic']).toBe(cyclic)
  })
})

describe('logger — the JSON record', () => {
  const entry = (overrides: Partial<LoggerDef.Entry> = {}): LoggerDef.Entry => ({
    level: LogLevel.info,
    time: 5,
    msg: 'hello',
    error: '',
    failures: [],
    bindings: {},
    data: undefined,
    ...overrides,
  })

  it('reserved record keys win: a colliding binding / data key moves to data.<key>', () => {
    const record = toRecord(
      entry({
        level: LogLevel.warn,
        error: 'app.x: boom',
        bindings: { level: 'binding-level', app: 'std' },
        data: {
          time: 'user-time',
          msg: 'user-msg',
          err: 'user-err',
          trace_id: 'user-trace',
          span_id: 'user-span',
          trace_flags: 'user-flags',
          n: 1,
        },
        trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), flags: 1 },
      }),
    )

    expect(record).toEqual({
      level: LogLevel.warn,
      time: 5,
      msg: 'hello',
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      trace_flags: '01',
      'data.level': 'binding-level',
      app: 'std',
      'data.time': 'user-time',
      'data.msg': 'user-msg',
      'data.err': 'user-err',
      'data.trace_id': 'user-trace',
      'data.span_id': 'user-span',
      'data.trace_flags': 'user-flags',
      n: 1,
      err: 'app.x: boom',
    })
  })

  it('the configured msgKey / errorKey are the reserved ones; `msg` is then a plain field', () => {
    expect(toRecord(entry({ data: { msg: 'm', problem: 'p' } }), 'note', 'problem')).toEqual({
      level: LogLevel.info,
      time: 5,
      note: 'hello',
      msg: 'm',
      'data.problem': 'p',
    })
  })

  it('trace_id / span_id / trace_flags (2 lowercase hex) only inside a span', () => {
    const traced = toRecord(
      entry({ trace: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), flags: 3 } }),
    )
    expect([traced['trace_id'], traced['span_id'], traced['trace_flags']]).toEqual([
      'c'.repeat(32),
      'd'.repeat(16),
      '03',
    ])

    expect(Object.keys(toRecord(entry()))).toEqual(['level', 'time', 'msg'])
  })

  it('a `__proto__` data key stays a field', () => {
    const data = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    const record = toRecord(entry({ data }))

    expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
    expect(Object.hasOwn(record, '__proto__')).toBe(true)
  })

  it('the `ozaco.telemetry = sent` routing marker (ctx.log) is not printed', async () => {
    const bindings = { 'ozaco.telemetry': 'sent', req: 'r-1' }

    expect(toRecord(entry({ bindings }))).toEqual({
      level: LogLevel.info,
      time: 5,
      msg: 'hello',
      req: 'r-1',
    })

    const pretty = await run(function* () {
      yield* JsonCodec.use()
      return yield* prettyFormat(entry({ time: 0, bindings }), false)
    })
    expect(unwrap(pretty)).toBe('[1970-01-01T00:00:00.000Z] INFO  req="r-1": hello')

    // any other value is an ordinary binding
    expect(toRecord(entry({ bindings: { 'ozaco.telemetry': 'x' } }))['ozaco.telemetry']).toBe('x')
  })
})
