/**
 * Hold-until-settled: a failure escaping a span is parked on its local trace and recorded ONCE,
 * with its FINAL state, when it settles — answered (`settle`), handled (an ancestor went on), or at
 * the local root.
 */
import type { Operation, Task } from 'std:effect'
import { attempt, EffectErrors, fork, race, sleep, spawn, suspend } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import type { Result } from 'std:result'
import { ResultErrors, appendCauses, fail, isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { traced, tracedResult } from './helpers'

const exceptionEvents = (data: TraceDef.SpanData) =>
  data.events.filter(event => event.name === 'exception')

describe('final state', () => {
  it('causes appended by an ancestor after the failure escaped appear in the exception', async () => {
    const { tracer, result } = await tracedResult(() =>
      Trace.actions.span('dispatch', function* () {
        const outcome = yield* attempt(() =>
          Trace.actions.span('db', { kind: 'client' }, () =>
            fail('db.unique', 'duplicate key', 'insert'),
          ),
        )

        // a plugin `error` hook: the SAME failure, more context
        return yield* appendCauses(outcome as Result.Failure<unknown>, 'todos:create')
      }),
    )

    expect(isFailure(result)).toBe(true)
    expect(tracer.exceptions()).toHaveLength(1)

    const db = tracer.span('db')
    const [event] = exceptionEvents(db)

    expect(event!.attributes!['ozaco.failure.causes']).toEqual(['insert', 'todos:create'])
    expect(String(event!.attributes!['exception.stacktrace'])).toContain('at todos:create')

    const [log] = tracer.exceptions()

    expect(log!.attributes['ozaco.failure.causes']).toEqual(['insert', 'todos:create'])
    expect(log!.context?.spanId).toBe(db.context.spanId)
    expect(log!.body).toBe('db.unique: duplicate key\n    at insert\n    at todos:create')

    // every span the failure escaped: error.type + error status (unclassified ⇒ 500)
    for (const name of ['db', 'dispatch']) {
      expect(tracer.span(name).attributes['error.type']).toBe('db.unique')
      expect(tracer.span(name).status).toEqual({ code: 'error', message: 'duplicate key' })
    }
  })

  it('the OUTERMOST classifier decides status and severity (4xx: WARN, only CLIENT spans fail)', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', { failure: { status: () => 404 } }, () =>
        Trace.actions.span('helper', { failure: { status: () => 500 } }, () =>
          Trace.actions.span('db', { kind: 'client' }, () => fail('todo.missing', 'no such todo')),
        ),
      ),
    )

    const [log] = tracer.exceptions()

    expect(log!.severityNumber).toBe(13)

    expect(tracer.span('db').status).toEqual({ code: 'error', message: 'no such todo' })

    for (const name of ['helper', 'dispatch']) {
      expect(tracer.span(name).status).toEqual({ code: 'unset' })
      expect(tracer.span(name).attributes['error.type']).toBe('todo.missing')
    }
  })

  it('a 5xx class fails every span and records ERROR', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', { failure: { status: () => 503 } }, () =>
        Trace.actions.span('inner', () => fail('todo.down', 'unavailable')),
      ),
    )

    expect(tracer.exceptions()[0]!.severityNumber).toBe(17)
    expect(tracer.span('inner').status.code).toBe('error')
    expect(tracer.span('dispatch').status.code).toBe('error')
  })

  it('a throwing classifier counts as unclassified (500); a custom error.type classifier wins', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span(
        'dispatch',
        {
          failure: {
            status: () => {
              throw new Error('classifier bug')
            },
            // the server's classifier: a thrown error (`asFailure`'s `std:result.unknown`) is
            // `server.internal`
            type: failure =>
              typeof failure.error === 'string' && failure.error !== ResultErrors.Unknown
                ? failure.error
                : 'server.internal',
          },
        },
        function* () {
          throw new TypeError('x is not a function')
        },
      ),
    )

    const dispatch = tracer.span('dispatch')

    expect(dispatch.status.code).toBe('error')
    expect(dispatch.attributes['error.type']).toBe('server.internal')

    const [log] = tracer.exceptions()

    expect(log!.severityNumber).toBe(17)
    // the exception keeps the failure's own tag
    expect(log!.attributes['exception.type']).toBe(ResultErrors.Unknown)
  })

  it('the log event name comes from the ORIGIN span', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', { failure: { eventName: 'ozaco.action.exception' } }, () =>
        Trace.actions.span('db', { failure: { eventName: 'db.client.operation.exception' } }, () =>
          fail('db.down'),
        ),
      ),
    )

    const [log] = tracer.exceptions()

    expect(log!.eventName).toBe('db.client.operation.exception')
    expect(log!.attributes['otel.event.name']).toBe('db.client.operation.exception')
    expect(exceptionEvents(tracer.span('db'))).toHaveLength(1)
    expect(exceptionEvents(tracer.span('dispatch'))).toHaveLength(0)
  })

  it('the recorded time is the failure time, clamped into the origin span', async () => {
    const early = fail('app.early', 'made before the span')

    const { tracer } = await tracedResult(() =>
      Trace.actions.span('origin', function* () {
        yield* sleep(3)

        return yield* early
      }),
    )

    const origin = tracer.span('origin')
    const [event] = exceptionEvents(origin)

    expect(event!.time).toBe(origin.start)
    expect(tracer.exceptions()[0]!.time).toBe(origin.start)
  })
})

describe('absorbed wraps', () => {
  it('a wrap (the inner failure nested) ⇒ ONE exception at the wrapping span, carrying both levels', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span(
        'dispatch',
        { failure: { eventName: 'ozaco.action.exception' } },
        function* () {
          const inner = yield* attempt(() =>
            Trace.actions.span('db', { kind: 'client' }, () => fail('db.unique', 'duplicate key')),
          )

          yield* sleep(2)

          return yield* fail('todo.conflict', 'already exists', inner)
        },
      ),
    )

    expect(tracer.exceptions()).toHaveLength(1)

    const [log] = tracer.exceptions()
    const dispatch = tracer.span('dispatch')
    const db = tracer.span('db')

    expect(log!.context?.spanId).toBe(dispatch.context.spanId)
    expect(log!.eventName).toBe('ozaco.action.exception')
    expect(log!.attributes['ozaco.failure.chain']).toEqual([
      'todo.conflict: already exists',
      'db.unique: duplicate key',
    ])
    expect(log!.body).toBe('todo.conflict: already exists\nCaused by: db.unique: duplicate key')

    expect(exceptionEvents(dispatch)).toHaveLength(1)
    expect(exceptionEvents(db)).toHaveLength(0)

    // the absorbed span keeps ITS failure's type and takes the settled status
    expect(db.attributes['error.type']).toBe('db.unique')
    expect(db.status.code).toBe('error')
    expect(dispatch.attributes['error.type']).toBe('todo.conflict')
  })

  it('an absorbed wrap under a 4xx classifier: the CLIENT span fails, the rest are unset', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', { failure: { status: () => 409 } }, function* () {
        const inner = yield* attempt(() =>
          Trace.actions.span('db', { kind: 'client' }, () => fail('db.unique', 'duplicate key')),
        )

        yield* sleep(2)

        return yield* fail('todo.conflict', 'already exists', inner)
      }),
    )

    expect(tracer.exceptions()[0]!.severityNumber).toBe(13)
    expect(tracer.span('db').status.code).toBe('error')
    expect(tracer.span('dispatch').status.code).toBe('unset')
  })
})

describe('where the exception lands', () => {
  it('a span opted out of sampling hands its exception to the nearest recording ancestor', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('parent', () =>
        Trace.actions.span('opted-out', { sampled: false }, () => fail('app.x', 'boom')),
      ),
    )

    const parent = tracer.span('parent')

    expect(exceptionEvents(parent)).toHaveLength(1)

    const [log] = tracer.exceptions()

    expect(log!.context?.spanId).toBe(parent.context.spanId)
    expect(log!.context!.flags & 1).toBe(1)
  })

  it('a throwing error hook masking a traced failure: ONE exception carrying both', async () => {
    const P = defineProtocol<unknown, { work(): Operation<void> }>({
      name: 'settle-masked',
      version: '1.0.0',
      defaults: {
        *work() {
          return yield* Trace.actions.span('op', () => fail('op.failed', 'the operation failed'))
        },
      },
    })

    const { tracer } = await tracedResult(function* () {
      yield* P.error({
        *work() {
          return yield* Trace.actions.span('hook-work', () => fail('hook.threw', 'the hook broke'))
        },
      })

      return yield* Trace.actions.span('dispatch', () => P.actions.work())
    })

    const [log, ...rest] = tracer.exceptions()

    expect(rest).toEqual([])
    expect(log!.severityNumber).toBe(17)
    expect(log!.attributes['ozaco.failure.chain']).toEqual([
      'hook.threw: the hook broke',
      'op.failed: the operation failed',
    ])
    expect(log!.context?.spanId).toBe(tracer.span('hook-work').context.spanId)
    expect(tracer.span('op').attributes['error.type']).toBe('op.failed')
  })
})

describe('handled failures', () => {
  it('an ancestor that goes on ⇒ the failure was handled: WARN, error.type only, statuses unset', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('dispatch', function* () {
        yield* attempt(() =>
          Trace.actions.span('cache', { kind: 'client' }, () => fail('cache.down', 'miss')),
        )

        return 'fallback'
      }),
    )

    const [log] = tracer.exceptions()

    expect(log!.severityNumber).toBe(13)
    expect(log!.context?.spanId).toBe(tracer.span('cache').context.spanId)
    // a handled failure (a fallback replaced it) marks the span it escaped, never fails it — even
    // a CLIENT span: `{ status = error }` finds only what failed the request
    expect(tracer.span('cache').status.code).toBe('unset')
    expect(tracer.span('cache').attributes['error.type']).toBe('cache.down')
    expect(tracer.span('dispatch').status.code).toBe('unset')
    expect(tracer.span('dispatch').attributes['error.type']).toBeUndefined()
  })

  it('a failed attempt that was retried leaves the attempt unset (error.type only), even a 5xx one', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span(
        'dispatch',
        { kind: 'server', failure: { status: () => 503 } },
        function* () {
          for (let at = 1; at <= 2; at += 1) {
            const outcome = yield* attempt(() =>
              Trace.actions.span(
                `attempt ${at}`,
                { kind: 'client', failure: { status: () => 503 } },
                function* () {
                  if (at === 1) {
                    return yield* fail('upstream.busy', 'try again')
                  }

                  return 'ok'
                },
              ),
            )

            if (!isFailure(outcome)) {
              return outcome.value
            }
          }

          return 'never'
        },
      ),
    )

    const first = tracer.span('attempt 1')

    expect(first.status.code).toBe('unset')
    expect(first.attributes['error.type']).toBe('upstream.busy')
    expect(tracer.span('attempt 2').status.code).toBe('unset')
    expect(tracer.span('dispatch').status.code).toBe('unset')
    expect(tracer.exceptions().map(log => log.severityNumber)).toEqual([13])
  })

  it('handledSeverity picks the severity of a handled failure', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('poll', function* () {
        yield* attempt(() =>
          Trace.actions.span('probe', { failure: { handledSeverity: 5 } }, () => fail('x')),
        )
      }),
    )

    expect(tracer.exceptions()[0]!.severityNumber).toBe(5)
  })

  it('an ancestor failing with an UNRELATED failure handled the first one', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', function* () {
        yield* attempt(() => Trace.actions.span('first', () => fail('app.first', 'swallowed')))

        return yield* Trace.actions.span('second', () => fail('app.second', 'raised'))
      }),
    )

    const logs = tracer.exceptions()

    expect(logs.map(log => [log.attributes['exception.type'], log.severityNumber])).toEqual([
      ['app.first', 13],
      ['app.second', 17],
    ])
    expect(tracer.span('dispatch').attributes['error.type']).toBe('app.second')
  })

  it('a long-lived parent settles the oldest handled failures past the pending cap', async () => {
    const { tracer, value } = await traced(function* (memory) {
      let during = 0

      yield* Trace.actions.span('loop', function* () {
        for (let at = 0; at < 130; at += 1) {
          // each failure escapes `step` into `attempt` — handled, but only known at `loop`'s end
          yield* attempt(() =>
            Trace.actions.span('step', function* () {
              yield* sleep(0)

              return yield* fail('app.step', `step ${at}`)
            }),
          )
        }

        during = memory.exceptions().length
      })

      return during
    })

    // 128 stay parked while `loop` runs; the two oldest were settled (handled) on overflow
    expect(value).toBe(2)
    expect(tracer.exceptions()).toHaveLength(130)
    expect(tracer.exceptions().every(log => log.severityNumber === 13)).toBe(true)
  })
})

describe('explicit settle (the edge / carrier answered)', () => {
  it('settle(f, { status: 404 }) ⇒ WARN, the internal dispatch unset, the edge untouched', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('GET /todos/:id', { kind: 'server' }, function* () {
        const outcome = yield* attempt(() =>
          Trace.actions.span('todos.get', () => fail('todo.missing', 'gone')),
        )

        if (isFailure(outcome)) {
          yield* Trace.actions.settle(outcome, { status: 404 })
        }

        return 'response'
      }),
    )

    const [log] = tracer.exceptions()

    expect(log!.severityNumber).toBe(13)
    expect(tracer.span('todos.get').status.code).toBe('unset')
    expect(tracer.span('todos.get').attributes['error.type']).toBe('todo.missing')
    expect(tracer.span('GET /todos/:id').status.code).toBe('unset')
    expect(tracer.span('GET /todos/:id').attributes['error.type']).toBeUndefined()
  })

  it('settle(f, { status: 500 }) ⇒ ERROR — not the WARN of a handled failure', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('edge', { kind: 'server' }, function* () {
        const outcome = yield* attempt(() =>
          Trace.actions.span('todos.explode', () => fail('todo.kaput', 'boom')),
        )

        yield* Trace.actions.settle(outcome as Result.Failure<unknown>, { status: 500 })
      }),
    )

    expect(tracer.exceptions()[0]!.severityNumber).toBe(17)
    expect(tracer.span('todos.explode').status).toEqual({ code: 'error', message: 'boom' })
  })

  it('the explicit status wins over the classifiers; settling twice is a no-op', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('edge', { kind: 'server' }, function* () {
        const outcome = (yield* attempt(() =>
          Trace.actions.span('dispatch', { failure: { status: () => 404 } }, () =>
            fail('todo.kaput'),
          ),
        )) as Result.Failure<unknown>

        yield* Trace.actions.settle(outcome, { status: 502 })
        yield* Trace.actions.settle(outcome, { status: 404 })
      }),
    )

    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.exceptions()[0]!.severityNumber).toBe(17)
  })

  it('without an active local trace settle() does nothing', async () => {
    const { tracer } = await traced(() => Trace.actions.settle(fail('nothing.pending')))

    expect(tracer.logs).toEqual([])
  })
})

describe('record once', () => {
  it('one exception however many spans the same failure escapes', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('a', () =>
        Trace.actions.span('b', () => Trace.actions.span('c', () => fail('app.deep', 'deep'))),
      ),
    )

    expect(tracer.exceptions()).toHaveLength(1)
    expect(exceptionEvents(tracer.span('c'))).toHaveLength(1)

    for (const name of ['a', 'b', 'c']) {
      expect(tracer.span(name).attributes['error.type']).toBe('app.deep')
    }
  })

  it('an explicit recordFailure wins; the escape then only sets statuses', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', () =>
        Trace.actions.span('attempt', function* () {
          const failure = fail('app.final', 'last attempt')

          yield* Trace.actions.recordFailure(failure, {
            severity: 17,
            eventName: 'ozaco.retry.exhausted',
          })

          return yield* failure
        }),
      ),
    )

    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.exceptions()[0]!.eventName).toBe('ozaco.retry.exhausted')
    expect(tracer.span('dispatch').status.code).toBe('error')
  })

  it('the same failure escaping two sibling spans of one trace is recorded once', async () => {
    const shared = fail('cache.down', 'leader failed')

    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', function* () {
        yield* attempt(() => Trace.actions.span('leader', () => shared))

        return yield* Trace.actions.span('follower', () => shared)
      }),
    )

    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.span('follower').attributes['error.type']).toBe('cache.down')
  })
})

describe('halts and crashed tasks', () => {
  it('a Halted failure is a cancellation: DEBUG, ozaco.cancelled, status unset', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('awaits', () => fail(EffectErrors.Halted, 'the task was halted')),
    )

    expect(tracer.exceptions()[0]!.severityNumber).toBe(5)
    expect(tracer.span('awaits').attributes['ozaco.cancelled']).toBe(true)
    expect(tracer.span('awaits').status.code).toBe('unset')
  })

  it('frames unwound by a crashed child task take the failure, not a cancellation', async () => {
    const { tracer, result } = await tracedResult(() =>
      Trace.actions.span('outer', () =>
        Trace.actions.span('parent', function* () {
          yield* spawn(() => Trace.actions.span('child', () => fail('app.crash', 'child failed')))
          yield* suspend()
        }),
      ),
    )

    expect(result).toMatchObject({ error: 'app.crash' })
    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.exceptions()[0]!.context?.spanId).toBe(tracer.span('child').context.spanId)

    for (const name of ['parent', 'outer']) {
      const data = tracer.span(name)

      expect(data.attributes['ozaco.cancelled']).toBeUndefined()
      expect(data.attributes['error.type']).toBe('app.crash')
      expect(data.status.code).toBe('error')
    }
  })

  it('a span halted with a HANDLED failure pending inside it is just cancelled', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('root', () =>
        race([
          Trace.actions.span('work', function* () {
            yield* attempt(() => Trace.actions.span('probe', () => fail('app.flaky', 'caught')))
            yield* suspend()
          }),
          sleep(5),
        ]),
      ),
    )

    const work = tracer.span('work')

    expect(work.attributes).toEqual({ 'ozaco.cancelled': true })
    expect(work.status.code).toBe('unset')
    expect(tracer.span('probe').status.code).toBe('unset')
    expect(tracer.span('probe').attributes['error.type']).toBe('app.flaky')
    expect(tracer.exceptions()[0]!.severityNumber).toBe(13)
  })

  it('a halted LOCAL ROOT whose body caught a failure is cancelled, the failure handled', async () => {
    // the failure escaped a span of the root's own task: uncaught, it would have failed the root —
    // so the root's body caught it; the halt (a race lost, a client gone) is a plain cancellation
    const { tracer } = await traced(() =>
      race([
        Trace.actions.span('root', function* () {
          yield* attempt(() => Trace.actions.span('probe', () => fail('app.flaky', 'caught')))
          yield* suspend()
        }),
        sleep(5),
      ]),
    )

    const root = tracer.span('root')

    expect(root.attributes).toEqual({ 'ozaco.cancelled': true })
    expect(root.status.code).toBe('unset')
    expect(tracer.span('probe').status.code).toBe('unset')
    expect(tracer.span('probe').attributes['error.type']).toBe('app.flaky')
    expect(tracer.exceptions().map(log => log.severityNumber)).toEqual([13])
  })

  it('a fork outliving its parent settles its own failure when it ends', async () => {
    const { tracer, value } = await traced(function* (memory) {
      let late: Task<unknown> | undefined

      yield* Trace.actions.span('parent', function* () {
        late = yield* fork(() =>
          attempt(() =>
            Trace.actions.span('orphan', function* () {
              yield* sleep(5)

              return yield* fail('app.late', 'after the parent')
            }),
          ),
        )
      })

      const before = memory.exceptions().length

      yield* late!

      return before
    })

    expect(value).toBe(0)
    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.span('orphan').status.code).toBe('error')
    expect(tracer.span('parent').status.code).toBe('unset')
  })
})
