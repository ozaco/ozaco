/**
 * `formatFailure(f, { chain: true })`: the Java-style multi-line rendering of a cause
 * chain — headers, `at <cause>` lines for the string causes, every nested failure a `Caused by:`
 * level (no JS stack is ever rendered) — and its UTF-8 byte budget: every level header is reserved
 * first (the innermost `Caused by:` always survives), the `at` lines fill the rest innermost
 * first, `... N more` elides. The one-line `formatFailure(f)` is pinned in transform.test.ts
 * (string causes) and chain.test.ts (nested failures inline).
 */
import type { Result } from 'std:result'
import { asFailure, fail, formatFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

/** The innermost failure: `count` string causes (the steps it went through). */
const innermost = (count: number, message = 'x is not a function') =>
  fail(
    'todos.sql',
    message,
    ...Array.from(
      { length: count },
      (_, index) =>
        `handler${index} (/app/src/todos/handlers/deep/path/${index}.ts:${index + 1}:9)`,
    ),
  )

const threeLevels = (steps: number) => {
  const mid = fail('todos.db-step', 'db step broke', 'reading row', innermost(steps))

  return fail('todo.kaput', 'boom', 'todos.explode', mid)
}

describe('formatFailure — chain rendering', () => {
  it('renders every level and its causes, Java style', () => {
    expect(formatFailure(threeLevels(2), { chain: true })).toBe(
      [
        'todo.kaput: boom',
        '    at todos.explode',
        'Caused by: todos.db-step: db step broke',
        '    at reading row',
        'Caused by: todos.sql: x is not a function',
        '    at handler0 (/app/src/todos/handlers/deep/path/0.ts:1:9)',
        '    at handler1 (/app/src/todos/handlers/deep/path/1.ts:2:9)',
      ].join('\n'),
    )
  })

  it('without chain it is the one-line format, a nested failure inline', () => {
    const line = 'todo.kaput: boom: todos.explode > (todos.db-step: db step broke)'

    expect(formatFailure(threeLevels(2))).toBe(line)
    expect(formatFailure(threeLevels(2), {})).toBe(line)
  })

  it('a lone failure is its header plus its causes; an empty message drops its segment', () => {
    expect(formatFailure(fail('std:io.exists'), { chain: true })).toBe('std:io.exists')
    expect(formatFailure(fail('tag', '', 'first', 'second'), { chain: true })).toBe(
      'tag\n    at first\n    at second',
    )
  })

  it('an asFailure fold is its own level — tag and serialized text, never its raw value', () => {
    const error = new TypeError('denied')

    error.stack = 'TypeError: denied\n    at handler0 (/app/src/handler.ts:1:9)'

    expect(formatFailure(asFailure(error, 'opening socket'), { chain: true })).toBe(
      ['std:result.unknown: TypeError: denied', '    at opening socket'].join('\n'),
    )
    expect(formatFailure(fail('net.dial', 'dial failed', asFailure(error)), { chain: true })).toBe(
      ['net.dial: dial failed', 'Caused by: std:result.unknown: TypeError: denied'].join('\n'),
    )
  })

  it('a remote origin is a string cause: an `at` line of its level', () => {
    const decoded = fail(
      'todo.kaput',
      'boom',
      'remote: todos.explode @ todos span 01234567',
      innermost(1),
    )

    expect(formatFailure(fail('gw.failed', 'gateway', decoded), { chain: true })).toBe(
      [
        'gw.failed: gateway',
        'Caused by: todo.kaput: boom',
        '    at remote: todos.explode @ todos span 01234567',
        'Caused by: todos.sql: x is not a function',
        '    at handler0 (/app/src/todos/handlers/deep/path/0.ts:1:9)',
      ].join('\n'),
    )
  })

  it('renders everything: a huge cause, a long message, every level — nothing cut', () => {
    const decoded = fail('db.down', 'm'.repeat(5000), `remote: ${'o'.repeat(10_000)}`)
    let failure: Result.Failure<unknown> = fail('app.wrap', 'wrapped', decoded)

    for (let index = 0; index < 20; index += 1) {
      failure = fail(`level.${index}`, '', failure)
    }

    const rendered = formatFailure(failure, { chain: true })

    expect(rendered).toContain(`Caused by: db.down: ${'m'.repeat(5000)}`)
    expect(rendered).toContain(`    at remote: ${'o'.repeat(10_000)}`)
    expect(rendered.split('\n')).toHaveLength(23)
  })
})
