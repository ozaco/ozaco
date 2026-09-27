/**
 * The cause chain lives in `causes`: `fail(tag, message, ...causes)` and `appendCauses(result,
 * ...causes)` normalize each — a string stays, a Failure (a failed Result) is nested as the SAME
 * object, a Success / `null` / `undefined` is dropped. A foreign value is never a cause: an
 * untyped caller's is folded by `asFailure` (`std:result.unknown`, the value kept as `raw`).
 * Wrapping is `fail(Tag, message, inner)`. The chain rendering (`formatFailure(f, { chain: true })`)
 * walks it depth first, 8 deep, cycle-safe — tags, messages and string causes only.
 */
import type { Result } from 'std:result'
import {
  ResultErrors,
  appendCauses,
  asFailure,
  fail,
  formatFailure,
  isFailure,
  succeed,
} from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

/** The nested failure at `index` of `failure.causes` (fails the test when it is a string). */
const nestedAt = (failure: Result.Failure<unknown>, index: number): Result.Failure<unknown> => {
  const cause = failure.causes[index]
  expect(isFailure(cause)).toBe(true)
  return cause as Result.Failure<unknown>
}

/** The chain rendering's header lines — one per level. */
const headers = (failure: Result.Failure<unknown>): string[] =>
  formatFailure(failure, { chain: true })
    .split('\n')
    .filter(line => !line.startsWith('    '))

describe('fail — causes', () => {
  it('keeps strings and nests a Failure as the SAME object, in the order given', () => {
    const inner = fail('db.step', 'row missing', 'reading row')
    const outer = fail('todo.kaput', 'boom', 'todos.explode', inner, 'after')

    expect(outer.error).toBe('todo.kaput')
    expect(outer.message).toBe('boom')
    expect(outer.causes).toEqual(['todos.explode', inner, 'after'])
    expect(outer.causes[1]).toBe(inner)
    // the inner failure is untouched — its causes are not copied outward
    expect(inner.causes).toEqual(['reading row'])
  })

  it('nests a failed Result as is and drops a Success, null and undefined', () => {
    const failed: Result<number, string> = fail('io.read')
    const outer = fail('app.load', '', succeed(1), failed, undefined, null, succeed())

    expect(outer.causes).toHaveLength(1)
    expect(outer.causes[0]).toBe(failed)
  })

  it('folds a foreign value an untyped caller passes as a cause, the value its raw', () => {
    const error = new TypeError('x is not a function')
    const outer = fail('app.call', 'call failed', error as AnyType, { reason: 'bad' } as AnyType)

    expect(nestedAt(outer, 0).error).toBe(ResultErrors.Unknown)
    expect(nestedAt(outer, 0).message).toBe('TypeError: x is not a function')
    expect(nestedAt(outer, 0).raw).toBe(error)
    expect(nestedAt(outer, 1).message).toBe('{"reason":"bad"}')
    // a failure built by `fail` carries no raw
    expect('raw' in outer).toBe(false)
  })

  it('infers the literal tag', () => {
    const outer: Result.Failure<'app.failed'> = fail('app.failed', 'msg', fail('inner'))
    expect(outer.error).toBe('app.failed')
  })

  it('renders a nested failure inline in the one-line format', () => {
    const inner = fail('db.step', 'row missing', 'reading row')
    const outer = fail('todo.kaput', 'boom', 'todos.explode', inner)

    expect(formatFailure(outer)).toBe('todo.kaput: boom: todos.explode > (db.step: row missing)')
    expect(formatFailure(fail('app.call', '', asFailure(new TypeError('denied'))))).toBe(
      'app.call: (std:result.unknown: TypeError: denied)',
    )
  })
})

describe('appendCauses — the same normalization, in place', () => {
  it('appends to the SAME failure object, a Failure nested as is', () => {
    const hook = fail('hook.threw', 'the hook broke')
    const masked = fail('op.failed')

    const out = appendCauses(hook, masked, 'hook.step')

    expect(out).toBe(hook)
    expect(hook.causes).toEqual([masked, 'hook.step'])
    expect(hook.causes[0]).toBe(masked)
  })

  it('leaves a Success alone and ignores Success causes (no isFailure guard needed)', () => {
    const ok = succeed(1)
    expect(appendCauses(ok, 'x', fail('y'))).toBe(ok)

    const failure = fail('a')
    appendCauses(failure, succeed(2))
    expect(failure.causes).toEqual([])
  })

  it('never makes a failure its own cause', () => {
    const failure = fail('self')
    appendCauses(failure, failure)
    expect(failure.causes).toEqual([])
  })

  it('settles a promise of a result to the same failure, causes appended', async () => {
    const failure = fail('later')
    const out = await (appendCauses(
      Promise.resolve(failure) as unknown as Result<never, string>,
      'after',
    ) as unknown as Promise<Result.Failure<string>>)

    expect(out).toBe(failure)
    expect(failure.causes).toEqual(['after'])
  })
})

describe('asFailure', () => {
  it('folds a foreign value `std:result.unknown`, the value its raw, then the causes given', () => {
    const error = new RangeError('kaput')
    const inner = fail('socket.closed')
    const wrapped = asFailure(error, 'loading', inner)

    expect(wrapped.error).toBe(ResultErrors.Unknown)
    expect(wrapped.message).toBe('RangeError: kaput')
    expect(wrapped.raw).toBe(error)
    expect(wrapped.causes).toEqual(['loading', inner])

    expect(asFailure('plain').raw).toBe('plain')
    expect(asFailure({ code: 1 }).message).toBe('{"code":1}')
  })

  it('passes a Failure through, its causes appended — no raw added', () => {
    const failure = fail('app.x', 'msg')

    expect(asFailure(failure, 'more')).toBe(failure)
    expect(failure.causes).toEqual(['more'])
    expect('raw' in failure).toBe(false)
  })
})

describe('the chain rendering walks the causes', () => {
  it('reads a 3-level chain outer → inner: tags, messages and string causes', () => {
    const fold = asFailure(new TypeError('x is not a function'))
    const mid = fail('db.step', 'row missing', 'reading row', fold)
    const outer = fail('todo.kaput', 'boom', 'todos.explode', mid)

    expect(formatFailure(outer, { chain: true })).toBe(
      [
        'todo.kaput: boom',
        '    at todos.explode',
        'Caused by: db.step: row missing',
        '    at reading row',
        'Caused by: std:result.unknown: TypeError: x is not a function',
      ].join('\n'),
    )
  })

  it('types a level by its tag, a non-string error as JSON', () => {
    expect(headers(fail('std:io.exists', 'there'))).toEqual(['std:io.exists: there'])
    expect(headers(fail({ reason: 'bad' }, 'msg'))).toEqual(['{"reason":"bad"}: msg'])
    expect(headers(fail())).toEqual(['undefined'])
  })

  it('a fold is one level: its raw value is never rendered', () => {
    expect(headers(asFailure(new Error('kaput')))).toEqual(['std:result.unknown: Error: kaput'])
  })

  it('walks several nested failures depth first, each after its string causes', () => {
    const left = fail('left', '', 'l.cause', fail('left.inner'))
    const right = fail('right', '', 'r.cause')
    const outer = fail('outer', '', 'o.cause', left, right)

    expect(formatFailure(outer, { chain: true })).toBe(
      [
        'outer',
        '    at o.cause',
        'Caused by: left',
        '    at l.cause',
        'Caused by: left.inner',
        'Caused by: right',
        '    at r.cause',
      ].join('\n'),
    )
  })

  it('follows nested failures 8 deep', () => {
    let failure: Result.Failure<unknown> = fail('level.0')
    for (let index = 1; index < 12; index += 1) {
      failure = fail(`level.${index}`, '', failure)
    }

    expect(headers(failure)).toHaveLength(8)
    expect(headers(failure)[0]).toBe('level.11')
    expect(headers(failure).at(-1)).toBe('Caused by: level.4')
  })

  it('is cycle-safe, and a failure shared twice renders once', () => {
    const first = fail('first')
    const second = fail('second', '', first)
    appendCauses(first, second)

    expect(headers(second)).toEqual(['second', 'Caused by: first'])

    const shared = fail('shared')
    expect(headers(fail('outer', '', shared, fail('mid', '', shared)))).toEqual([
      'outer',
      'Caused by: shared',
      'Caused by: mid',
    ])
  })
})

describe('foreign errors with throwing getters', () => {
  /** An Error whose own `stack`, `message`, `name`, `code` and `cause` getters all throw. */
  const hostile = (): Error => {
    const error = new Error('hidden')
    for (const key of ['stack', 'message', 'name', 'code', 'cause']) {
      Object.defineProperty(error, key, {
        get() {
          throw new Error(`no ${key} for you`)
        },
      })
    }
    return error
  }

  it('folding and rendering them never throw', () => {
    const fold = asFailure(hostile())

    expect(fold.message).toBe('[object Error]')
    expect(formatFailure(fold)).toBe('std:result.unknown: [object Error]')
    expect(formatFailure(fail('app.wrap', 'wrapped', fold), { chain: true })).toBe(
      'app.wrap: wrapped\nCaused by: std:result.unknown: [object Error]',
    )
  })
})
