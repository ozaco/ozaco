import { ResultErrors, asFailure, fail } from 'std:result'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { exceptionAttributes, exceptionType } from '../../src/trace/internal/exception'

import { tracedResult } from './helpers'

/** A pg failure with 30 string causes, wrapped twice: todo.kaput → db.query → pg.sql. */
const threeLevels = (message = 'x is not a function') => {
  const sql = fail(
    'pg.sql',
    message,
    ...Array.from(
      { length: 30 },
      (_, at) => `handler${at} (/app/src/services/todos/handler-${at}.ts:${at + 1}:9)`,
    ),
  )

  const query = fail('db.query', 'query failed', 'select todos', sql)

  return fail('todo.kaput', 'boom', 'todos.db-step', query)
}

describe('exceptionType', () => {
  it('is the tag (a non-string error as its serialized text)', () => {
    expect(exceptionType(fail('todo.kaput'))).toBe('todo.kaput')
    expect(exceptionType(fail({ code: 'E_PLAIN' }))).toBe('{"code":"E_PLAIN"}')
    expect(exceptionType(fail(404))).toBe('404')
  })

  it('a thrown error folded by asFailure is typed std:result.unknown — its raw is never read', () => {
    const coded = Object.assign(new Error('no file'), { code: 'ENOENT' })

    expect(exceptionType(asFailure(coded))).toBe(ResultErrors.Unknown)
    expect(exceptionType(asFailure('plain'))).toBe(ResultErrors.Unknown)
    // any other tag keeps it, whatever it wraps
    expect(exceptionType(fail('app.wrap', 'x', asFailure(new TypeError('inner'))))).toBe('app.wrap')
  })

  it('the exception pair of an asFailure fold is its tag and message; the chain one level', () => {
    const attributes = exceptionAttributes(asFailure(new TypeError('x is not a function')))

    expect(attributes['exception.type']).toBe(ResultErrors.Unknown)
    expect(attributes['exception.message']).toBe('TypeError: x is not a function')
    expect(attributes['ozaco.failure.chain']).toEqual([
      'std:result.unknown: TypeError: x is not a function',
    ])
  })
})

describe('renderFailure / exceptionAttributes', () => {
  it('exception attributes carry the whole chain, nothing cut', () => {
    const failure = threeLevels('y'.repeat(20_000))
    const attributes = exceptionAttributes(failure)
    const stack = String(attributes['exception.stacktrace'])

    expect(stack.startsWith('todo.kaput: boom\n    at todos.db-step')).toBe(true)
    expect(stack).toContain(`Caused by: pg.sql: ${'y'.repeat(20_000)}`)
    expect(stack).toContain('    at handler29 (')

    expect(attributes['exception.type']).toBe('todo.kaput')
    expect(attributes['exception.message']).toBe('boom')
    expect(attributes['ozaco.failure.chain']).toEqual([
      'todo.kaput: boom',
      'db.query: query failed',
      `pg.sql: ${'y'.repeat(20_000)}`,
    ])
    expect(attributes['ozaco.failure.causes']).toEqual(['todos.db-step'])
    expect(attributes['error.type']).toBeUndefined()
  })

  it('ozaco.failure.causes holds the string causes only, and is left out when there are none', () => {
    // an empty array is no value every sink keeps (OpenObserve drops it): it is not emitted
    expect('ozaco.failure.causes' in exceptionAttributes(fail('app.flat', 'flat'))).toBe(false)
    expect(
      'ozaco.failure.causes' in exceptionAttributes(fail('app.wrap', '', fail('app.inner'))),
    ).toBe(false)
    expect(
      exceptionAttributes(fail('app.wrap', '', 'first', fail('app.inner', '', 'inner'), 'second'))[
        'ozaco.failure.causes'
      ],
    ).toEqual(['first', 'second'])
  })

  it('ozaco.failure.chain lists every nested failure depth first', () => {
    const failure = fail(
      'app.outer',
      'outer',
      fail('app.left', '', fail('app.left.inner', 'deep')),
      asFailure(new RangeError('right')),
      fail({ reason: 'object' }, 'object error'),
    )

    expect(exceptionAttributes(failure)['ozaco.failure.chain']).toEqual([
      'app.outer: outer',
      'app.left',
      'app.left.inner: deep',
      'std:result.unknown: RangeError: right',
      '{"reason":"object"}: object error',
    ])
  })

  it('ozaco.failure.chain is there even for one level', () => {
    expect(exceptionAttributes(fail('app.flat', 'flat'))['ozaco.failure.chain']).toEqual([
      'app.flat: flat',
    ])
    expect(exceptionAttributes(fail('app.bare'))['ozaco.failure.chain']).toEqual(['app.bare'])
    expect(exceptionAttributes(fail('app.bare'))['exception.message']).toBe('app.bare')
  })

  it('a recorded failure: the chain is whole, the span event under the span value cap', async () => {
    const failure = threeLevels('z'.repeat(150))

    const { tracer } = await tracedResult(() => Trace.actions.span('dispatch', () => failure))

    const [event] = tracer.span('dispatch').events
    const eventStack = String(event!.attributes!['exception.stacktrace'])

    // a span event's values are ≤ 2048 bytes like every span attribute; the levels stay listed
    expect(new TextEncoder().encode(eventStack).length).toBeLessThanOrEqual(2048)
    expect(eventStack.startsWith('todo.kaput: boom')).toBe(true)
    expect(event!.attributes!['ozaco.failure.chain']).toEqual([
      'todo.kaput: boom',
      'db.query: query failed',
      `pg.sql: ${'z'.repeat(150)}`,
    ])

    const [log] = tracer.exceptions()
    const logStack = String(log!.attributes['exception.stacktrace'])

    expect(logStack).toContain('handler29 (')
    expect(log!.body).toBe(logStack)
    expect(log!.body.split('\n')[0]).toBe('todo.kaput: boom')
    expect(log!.attributes['ozaco.failure.chain']).toHaveLength(3)
  })

  it('a thrown Error fails its span with the fold: its message the exception.message text', async () => {
    const { tracer, result } = await tracedResult(() =>
      Trace.actions.span('dispatch', function* () {
        throw new RangeError('disk 9 is on fire')
      }),
    )

    expect(result).toMatchObject({ error: ResultErrors.Unknown })

    const dispatch = tracer.span('dispatch')
    const [log] = tracer.exceptions()

    expect(log!.attributes['exception.message']).toBe('RangeError: disk 9 is on fire')
    expect(dispatch.status).toEqual({ code: 'error', message: 'RangeError: disk 9 is on fire' })
    expect(dispatch.attributes['error.type']).toBe(ResultErrors.Unknown)
  })

  it('the status message of a failure without a message is its tag', async () => {
    const { tracer } = await tracedResult(() =>
      Trace.actions.span('dispatch', () => fail('app.bad')),
    )

    expect(tracer.span('dispatch').status).toEqual({ code: 'error', message: 'app.bad' })
    expect(tracer.exceptions()[0]!.attributes['exception.message']).toBe('app.bad')
  })
})
