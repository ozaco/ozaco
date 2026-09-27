import { ResultErrors, asFailure, fail } from 'std:result'
import { exceptionAttributes, exceptionType, renderFailure, span } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { tracedResult } from './helpers'

const bytes = (text: unknown): number => new TextEncoder().encode(String(text)).length

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
  it('the 2000-byte span-event copy keeps every header, the innermost one included', () => {
    const failure = threeLevels()
    const attributes = exceptionAttributes(failure, { maxBytes: 2000 })
    const stack = String(attributes['exception.stacktrace'])

    expect(bytes(stack)).toBeLessThanOrEqual(2000)
    expect(stack.startsWith('todo.kaput: boom\n    at todos.db-step')).toBe(true)
    expect(stack).toContain('Caused by: db.query: query failed')
    expect(stack).toContain('Caused by: pg.sql: x is not a function')
    expect(stack).toContain('    at handler0 (')

    expect(attributes['exception.type']).toBe('todo.kaput')
    expect(attributes['exception.message']).toBe('boom')
    expect(attributes['ozaco.failure.chain']).toEqual([
      'todo.kaput: boom',
      'db.query: query failed',
      'pg.sql: x is not a function',
    ])
    expect(attributes['ozaco.failure.causes']).toEqual(['todos.db-step'])
    expect(attributes['error.type']).toBeUndefined()
  })

  it('huge messages are cut, never the innermost header', () => {
    const failure = threeLevels('y'.repeat(20_000))
    const stack = renderFailure(failure, { maxBytes: 2000 })

    expect(bytes(stack)).toBeLessThanOrEqual(2000)
    expect(stack).toContain('Caused by: pg.sql: yyy')

    const chain = exceptionAttributes(failure)['ozaco.failure.chain'] as string[]
    expect(bytes(chain.at(-1))).toBeLessThanOrEqual(2048)
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

  it('renderFailure without a budget keeps up to 16 KiB — all 30 causes here', () => {
    const stack = renderFailure(threeLevels())
    expect(stack).toContain('handler29 (')
    expect(bytes(stack)).toBeLessThanOrEqual(16_384)
  })

  it('a recorded failure: the span event is budgeted, the log record carries the full chain', async () => {
    const failure = threeLevels('z'.repeat(150))

    const { tracer } = await tracedResult(() => span('dispatch', () => failure))

    const [event] = tracer.span('dispatch').events
    const eventStack = String(event!.attributes!['exception.stacktrace'])
    expect(bytes(eventStack)).toBeLessThanOrEqual(2000)
    expect(eventStack).toContain('Caused by: pg.sql: zzz')

    const [log] = tracer.exceptions()
    const logStack = String(log!.attributes['exception.stacktrace'])
    expect(logStack).toContain('handler29 (')
    expect(log!.body).toBe(logStack)
    expect(log!.body.split('\n')[0]).toBe('todo.kaput: boom')
    expect(log!.attributes['ozaco.failure.chain']).toHaveLength(3)
  })

  it('a thrown Error fails its span with the fold: its message the exception.message text', async () => {
    const { tracer, result } = await tracedResult(() =>
      span('dispatch', function* () {
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
    const { tracer } = await tracedResult(() => span('dispatch', () => fail('app.bad')))

    expect(tracer.span('dispatch').status).toEqual({ code: 'error', message: 'app.bad' })
    expect(tracer.exceptions()[0]!.attributes['exception.message']).toBe('app.bad')
  })
})
