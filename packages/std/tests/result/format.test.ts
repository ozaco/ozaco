/**
 * `formatFailure(f, { chain: true, maxBytes? })`: the Java-style multi-line rendering of a cause
 * chain — headers, `at <cause>` lines for the string causes, every nested failure a `Caused by:`
 * level (no JS stack is ever rendered) — and its UTF-8 byte budget: every level header is reserved
 * first (the innermost `Caused by:` always survives), the `at` lines fill the rest innermost
 * first, `... N more` elides. The one-line `formatFailure(f)` is pinned in transform.test.ts
 * (string causes) and chain.test.ts (nested failures inline).
 */
import type { Result } from 'std:result'
import { asFailure, fail, formatFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

const bytes = (text: string): number => new TextEncoder().encode(text).length

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

  it('an unbounded cause off a wire never crowds the root cause out of the budget', () => {
    // untrusted wire data: a huge cause is an `at` line, which gives way before any header
    const decoded = fail('db.down', 'connection refused', `remote: ${'o'.repeat(10_000)}`)
    const wrapped = fail('app.wrap', 'wrapped', decoded)

    const budgeted = formatFailure(wrapped, { chain: true, maxBytes: 2000 })
    expect(bytes(budgeted)).toBeLessThanOrEqual(2000)
    expect(budgeted).toBe(
      'app.wrap: wrapped\nCaused by: db.down: connection refused\n    ... 1 more',
    )

    const tight = formatFailure(wrapped, { chain: true, maxBytes: 60 })
    expect(bytes(tight)).toBeLessThanOrEqual(60)
    expect(tight).toContain('Caused by: db.down: connection refused')
  })
})

describe('formatFailure — byte budget', () => {
  it('a 3-level chain with 30 innermost causes in 2000 bytes keeps every header and elides', () => {
    const rendered = formatFailure(threeLevels(30), { chain: true, maxBytes: 2000 })

    expect(bytes(rendered)).toBeLessThanOrEqual(2000)
    expect(rendered.startsWith('todo.kaput: boom\n')).toBe(true)
    expect(rendered).toContain('\nCaused by: todos.db-step: db step broke')
    expect(rendered).toContain('\nCaused by: todos.sql: x is not a function\n')
    expect(rendered).toMatch(/\n {4}\.\.\. \d+ more(\n|$)/u)
    // the innermost causes are filled first
    expect(rendered).toContain('at handler0 ')
    expect(rendered).not.toContain('at handler29 ')
  })

  it('elides every level with `... N more` rather than dropping lines silently', () => {
    const rendered = formatFailure(threeLevels(30), { chain: true, maxBytes: 300 })
    const lines = rendered.split('\n')

    expect(bytes(rendered)).toBeLessThanOrEqual(300)
    expect(lines.filter(line => line.startsWith('Caused by: '))).toHaveLength(2)
    // each level with lines either shows them all or counts what it hid
    const counted = lines.filter(line => /^ {4}\.\.\. \d+ more$/u.test(line))
    expect(counted.length).toBeGreaterThanOrEqual(1)
    expect(lines.at(-1)).toMatch(/^ {4}(at handler|\.\.\. \d+ more)/u)
  })

  it('never drops the innermost header: middle, then outer levels go first', () => {
    const tight = formatFailure(threeLevels(30), { chain: true, maxBytes: 90 })
    expect(bytes(tight)).toBeLessThanOrEqual(90)
    expect(tight).toContain('Caused by: todos.sql: x is not a function')
    expect(tight).toContain('... 1 more level')

    const tighter = formatFailure(threeLevels(30), { chain: true, maxBytes: 50 })
    expect(bytes(tighter)).toBeLessThanOrEqual(50)
    expect(tighter).toContain('Caused by: todos.sql: x is not a function')
    expect(tighter).not.toContain('todo.kaput')

    // below even that: the innermost header, cut
    const cut = formatFailure(threeLevels(30), { chain: true, maxBytes: 20 })
    expect(bytes(cut)).toBeLessThanOrEqual(20)
    expect(cut.startsWith('Caused by: ')).toBe(true)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('cuts messages to 200 bytes under a budget, on a code-point boundary', () => {
    const long = '🔥'.repeat(300)
    const rendered = formatFailure(fail('tag', long, fail('inner', long)), {
      chain: true,
      maxBytes: 2000,
    })
    const [first] = rendered.split('\n')

    expect(bytes(rendered)).toBeLessThanOrEqual(2000)
    expect(bytes(first as string)).toBeLessThanOrEqual('tag: '.length + 200)
    expect(first?.endsWith('…')).toBe(true)
    expect(rendered).not.toContain('�')
    expect(rendered).toContain('Caused by: inner: 🔥')
  })

  it('without maxBytes renders everything up to 16 KiB, the innermost header kept', () => {
    const rendered = formatFailure(threeLevels(2000), { chain: true })

    expect(bytes(rendered)).toBeLessThanOrEqual(16_384)
    expect(rendered).toContain('Caused by: todos.sql: x is not a function')
    expect(rendered).toMatch(/\.\.\. \d+ more$/u)

    // messages are not cut at 200 bytes without a budget
    const message = 'm'.repeat(1000)
    expect(formatFailure(fail('tag', message), { chain: true })).toBe(`tag: ${message}`)
  })

  it('renders at most 8 levels', () => {
    let failure: Result.Failure<unknown> = fail('level.0')
    for (let index = 1; index < 12; index += 1) {
      failure = fail(`level.${index}`, '', failure)
    }

    const rendered = formatFailure(failure, { chain: true })
    expect(rendered.split('\n')).toHaveLength(8)
    expect(rendered.split('\n').at(-1)).toBe('Caused by: level.4')
  })
})
