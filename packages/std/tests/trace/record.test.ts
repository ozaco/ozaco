import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import { current, isRecorded, markRecorded, recordFailure, span } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { traced, tracedResult } from './helpers'

describe('record once per (failure, trace)', () => {
  it('the SAME failure object failing in two traces is recorded once in EACH', async () => {
    const shared = fail('cache.down', 'redis unreachable')

    const { tracer } = await traced(function* () {
      // a singleflight leader and a follower in another request: one Failure object, two traces
      yield* attempt(() => span('request-a', () => shared))
      yield* attempt(() => span('request-b', () => shared))
    })

    const a = tracer.span('request-a').context.traceId
    const b = tracer.span('request-b').context.traceId
    expect(a).not.toBe(b)

    const logs = tracer.exceptions()
    expect(logs.map(log => log.context?.traceId)).toEqual([a, b])
    expect(isRecorded(shared, a)).toBe(true)
    expect(isRecorded(shared, b)).toBe(true)
    expect(isRecorded(shared, 'f'.repeat(32))).toBe(false)
  })

  it('markRecorded / isRecorded share one registry across std copies (globalThis symbol)', () => {
    const failure = fail('app.x')
    markRecorded(failure, 'trace-1')

    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for('std:trace.recorded')] as
      | WeakMap<object, Set<string>>
      | undefined

    expect(registry?.get(failure)?.has('trace-1')).toBe(true)
    expect(isRecorded(failure, 'trace-1')).toBe(true)
    expect(isRecorded(failure, 'trace-2')).toBe(false)
  })

  it('a long-lived shared failure keeps only the latest 128 trace ids (a bounded registry)', async () => {
    const memoized = fail('app.init', 'the lazy init failed once')

    await traced(function* () {
      for (let at = 0; at < 300; at += 1) {
        yield* attempt(() => span(`request-${at}`, { parent: null }, () => memoized))
      }
    })

    const registry = (globalThis as Record<symbol, unknown>)[
      Symbol.for('std:trace.recorded')
    ] as WeakMap<object, Set<string>>
    expect(registry.get(memoized)?.size).toBe(128)
  })

  /** A failure as a reply decoder raises it: the sender's origin as a string cause, marked
   * recorded (`remote: true`) in the active trace when the sender said it recorded it. */
  const decoded = (recorded: boolean, seen: Result.Failure<unknown>[] = []) =>
    function* (): Operation<never> {
      const failure = fail('todo.kaput', 'boom', 'remote: todos.explode @ api span abcdef01')
      seen.push(failure)
      if (recorded) {
        markRecorded(failure, (yield* current()).context.traceId, { remote: true })
      }
      return yield* failure
    }

  it('a failure the other side recorded is NOT recorded again — status, error.type, remote marker', async () => {
    const seen: Result.Failure<unknown>[] = []

    const { tracer } = await tracedResult(() =>
      span('todos.explode', { kind: 'client' }, decoded(true, seen)),
    )

    expect(tracer.exceptions()).toHaveLength(0)
    const data = tracer.span('todos.explode')
    expect(data.status).toEqual({ code: 'error', message: 'boom' })
    expect(data.attributes).toMatchObject({
      'error.type': 'todo.kaput',
      'ozaco.failure.remote': true,
    })
    expect(data.events).toEqual([])
    expect(isRecorded(seen[0]!, data.context.traceId)).toBe(true)
  })

  it('a remote failure nobody recorded yet is recorded here, its origin an `at` line', async () => {
    const { tracer } = await tracedResult(() => span('call', { kind: 'client' }, decoded(false)))

    const [log] = tracer.exceptions()
    expect(tracer.exceptions()).toHaveLength(1)
    expect(log!.body).toBe('todo.kaput: boom\n    at remote: todos.explode @ api span abcdef01')
    // the exception is HERE: nothing points elsewhere
    expect(tracer.span('call').attributes['ozaco.failure.remote']).toBeUndefined()
  })

  it('markRecorded without `remote` (a log line took the exception) adds no remote marker', async () => {
    const { tracer } = await tracedResult(() =>
      span('handler', function* () {
        const failure = fail('app.x', 'logged')
        markRecorded(failure, (yield* current()).context.traceId)
        return failure
      }),
    )

    expect(tracer.exceptions()).toHaveLength(0)
    expect(tracer.span('handler').attributes['error.type']).toBe('app.x')
    expect(tracer.span('handler').attributes['ozaco.failure.remote']).toBeUndefined()
  })

  it('a local wrap of a remote-recorded failure is new information: it is recorded', async () => {
    const { tracer } = await tracedResult(() =>
      span('gateway', function* () {
        const outcome = yield* attempt(() => span('call', { kind: 'client' }, decoded(true)))
        return yield* fail('gateway.failed', 'upstream failed', outcome)
      }),
    )

    const [log] = tracer.exceptions()
    expect(tracer.exceptions()).toHaveLength(1)
    expect(log!.context?.spanId).toBe(tracer.span('gateway').context.spanId)
    expect(log!.body).toBe(
      [
        'gateway.failed: upstream failed',
        'Caused by: todo.kaput: boom',
        '    at remote: todos.explode @ api span abcdef01',
      ].join('\n'),
    )
    expect(tracer.span('call').attributes['ozaco.failure.remote']).toBe(true)
    expect(tracer.span('gateway').attributes['ozaco.failure.remote']).toBeUndefined()
  })
})

describe('recordFailure', () => {
  it('records on the active span now: event + log, severity / eventName / handled', async () => {
    const { tracer } = await traced(() =>
      span('attempt', function* () {
        yield* recordFailure(fail('app.retry', 'will retry'), { handled: true })
        yield* recordFailure(fail('app.fatal', 'gave up'), { severity: 21, eventName: 'app.fatal' })
      }),
    )

    const [retry, fatal] = tracer.exceptions()
    expect(retry).toMatchObject({ severityNumber: 13, eventName: 'exception' })
    expect(fatal).toMatchObject({ severityNumber: 21, eventName: 'app.fatal' })
    expect(tracer.span('attempt').events.map(event => event.name)).toEqual([
      'exception',
      'exception',
    ])
    // recording a failure does not set the status
    expect(tracer.span('attempt').status.code).toBe('unset')
  })

  it("uses the span's failure.eventName by default", async () => {
    const { tracer } = await traced(() =>
      span('db', { failure: { eventName: 'db.client.operation.exception' } }, () =>
        recordFailure(fail('db.slow')),
      ),
    )

    expect(tracer.exceptions()[0]!.eventName).toBe('db.client.operation.exception')
  })

  it('without an active span it still emits the log record (no context)', async () => {
    const { tracer } = await traced(() => recordFailure(fail('app.boot', 'config missing')))

    const [log] = tracer.exceptions()
    expect(log).toMatchObject({ context: null, service: null, severityNumber: 17 })
    expect(log!.scope.name).toBe('@ozaco/std')
  })

  it('handle.recordFailure records on THAT span', async () => {
    const { tracer } = await traced(() =>
      span('outer', function* (outer) {
        yield* span('inner', function* () {
          yield* outer.recordFailure(fail('app.outer'))
          yield* (yield* current()).recordFailure(fail('app.inner'))
        })
      }),
    )

    expect(tracer.span('outer').events.map(event => event.attributes?.['exception.type'])).toEqual([
      'app.outer',
    ])
    expect(tracer.span('inner').events.map(event => event.attributes?.['exception.type'])).toEqual([
      'app.inner',
    ])
  })
})
