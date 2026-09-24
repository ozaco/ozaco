import {
  appendCauses,
  asFailure,
  asFailureFrom,
  formatFailure,
  auto,
  fail,
  isFailure,
  isSuccess,
  succeed,
  throwable,
  unwrap,
} from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

describe('unwrap', () => {
  it('returns the success value and passes non-results through unchanged', () => {
    expect(unwrap(succeed('payload'))).toBe('payload')
    expect(unwrap(succeed())).toBeUndefined()

    expect(unwrap(42 as AnyType) as number).toBe(42)
    expect(unwrap(null as AnyType)).toBeNull()
  })

  it('throws the failure object itself when no default is given', () => {
    const failure = fail('nope')

    let caught: unknown
    try {
      unwrap(failure)
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(failure)
  })

  it('substitutes the default for a failure, never for a success', () => {
    expect(unwrap(fail('nope'), 'fallback')).toBe('fallback')
    expect(unwrap(succeed('real'), 'fallback')).toBe('real')
  })

  it('resolves through promises of results', async () => {
    const eventual = unwrap(Promise.resolve(succeed(7)) as AnyType) as Promise<number>
    expect(await eventual).toBe(7)

    const failure = fail('late')
    const substituted = unwrap(Promise.resolve(failure) as AnyType, 'fallback') as Promise<string>
    expect(await substituted).toBe('fallback')

    let caught: unknown
    try {
      await unwrap(Promise.resolve(failure) as AnyType)
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
  })
})

describe('appendCauses', () => {
  it('mutates the failure in place, preserving order, and returns the same reference', () => {
    const failure = fail('root', 'went wrong', 'first')
    const returned = appendCauses(failure, 'second', 'third')

    expect(returned).toBe(failure)
    if (isFailure(failure)) {
      expect(failure.causes).toEqual(['first', 'second', 'third'])
    }

    // successes flow through untouched — no causes property is invented
    const ok = succeed('fine')
    expect(appendCauses(ok, 'ignored')).toBe(ok)
    expect('causes' in ok).toBe(false)
  })

  it('applies through a promise of a result', async () => {
    const failure = fail('root')
    const settled = await (appendCauses(Promise.resolve(failure) as AnyType, 'later') as AnyType)

    expect(settled).toBe(failure)
    if (isFailure(failure)) {
      expect(failure.causes).toEqual(['later'])
    }
  })
})

describe('asFailure / asFailureFrom', () => {
  it('reuses an existing failure and wraps anything else', () => {
    const original = fail('root')
    const decorated = asFailure(original as AnyType, 'while retrying')
    expect(decorated).toBe(original as AnyType)
    expect(decorated.causes).toEqual(['while retrying'])

    const wrapped = asFailure('raw-error')
    expect(isFailure(wrapped)).toBe(true)
    expect(wrapped.error).toBe('raw-error')
    expect(wrapped.message).toBe('')
  })

  it('asFailure keeps an Error in the error slot and copies its text into message', () => {
    const error = new TypeError('denied')
    const wrapped = asFailure(error, 'opening socket')
    expect(wrapped.error).toBe(error)
    expect(wrapped.message).toBe('denied')
    expect(wrapped.causes).toEqual(['opening socket'])

    // a non-Error keeps the empty message
    expect(asFailure({ code: 1 }).message).toBe('')
  })

  it('asFailureFrom tags a foreign error `std:result.unknown` and serializes it into the message', () => {
    const wrapped = asFailureFrom(new Error('kaput'), 'loading config')
    expect(wrapped.error).toBe('std:result.unknown')
    expect(wrapped.message).toBe('Error: kaput')
    expect(wrapped.causes).toEqual(['loading config'])
    expect(asFailureFrom('plain').message).toBe('plain')

    const existing = fail('typed')
    expect(asFailureFrom(existing as AnyType)).toBe(existing as AnyType)
  })
})

describe('auto', () => {
  it('passes results through by reference and wraps plain values', () => {
    const ok = succeed(1)
    const bad = fail('x')

    expect(auto(ok)).toBe(ok)
    expect(auto(bad)).toBe(bad)

    const wrapped = auto('plain')
    expect(isSuccess(wrapped)).toBe(true)
    expect(unwrap(wrapped)).toBe('plain')
  })

  it('swaps a failure for the default, which itself goes through auto', () => {
    const bad = fail('x')

    expect(unwrap(auto(bad, 'fallback'))).toBe('fallback')

    // a default that is already a result is passed through as-is
    const fallbackFailure = fail('fallback-error')
    expect(auto(bad as AnyType, fallbackFailure)).toBe(fallbackFailure as AnyType)

    // successes never trigger the default
    const ok = succeed('kept')
    expect(auto(ok, 'unused')).toBe(ok as AnyType)
  })
})

describe('throwable', () => {
  it('wraps returned values and passes existing results through', () => {
    expect(unwrap(throwable(() => 21))).toBe(21)

    const existing = succeed('kept')
    expect(throwable(() => existing)).toBe(existing as AnyType)
  })

  it('captures a thrown error with the marker message and causes', () => {
    const outcome = throwable(() => JSON.parse('{oops'), SyntaxError, 'parsing config')

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBeInstanceOf(SyntaxError)
      expect(outcome.message).toBe('from throwable')
      expect(outcome.causes).toEqual(['parsing config'])
    }

    // a throw that is not an instance of the requested class gets wrapped into it
    const foreign = throwable(() => {
      throw new TypeError('raw reason')
    }, RangeError)

    expect(isFailure(foreign)).toBe(true)
    if (isFailure(foreign)) {
      expect(foreign.error).toBeInstanceOf(RangeError)
      expect((foreign.error as RangeError).message).toContain('raw reason')
    }
  })

  it('settles async callbacks into results', async () => {
    const ok = await (throwable(() => Promise.resolve('done')) as AnyType)
    expect(unwrap(ok) as string).toBe('done')

    const bad = await (throwable(() => Promise.reject(new Error('kaput'))) as AnyType)
    expect(isFailure(bad)).toBe(true)
    if (isFailure(bad)) {
      expect(bad.error).toBeInstanceOf(Error)
      expect(bad.message).toBe('from throwable')
    }
  })
})

describe('formatFailure', () => {
  it('renders error: message: causes, dropping empty segments', () => {
    expect(formatFailure(fail('std:io.exists'))).toBe('std:io.exists')
    expect(formatFailure(fail('std:io.exists', 'already there'))).toBe(
      'std:io.exists: already there',
    )
    expect(formatFailure(fail('tag', 'msg', 'outer', 'inner'))).toBe('tag: msg: outer > inner')
    expect(formatFailure(fail('tag', '', 'only-cause'))).toBe('tag: only-cause')
  })

  it('renders an Error by name + message, never `{}`, and does not repeat a folded message', () => {
    expect(formatFailure(fail(new TypeError('denied'), 'while dialing'))).toBe(
      'TypeError: denied: while dialing',
    )
    expect(formatFailure(asFailure(new Error('kaput'), 'loading'))).toBe('Error: kaput: loading')
    expect(formatFailure(asFailureFrom(new Error('kaput'), 'loading'))).toBe(
      'std:result.unknown: Error: kaput: loading',
    )

    const coded = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    expect(formatFailure(asFailureFrom(coded))).toBe(
      'std:result.unknown: Error: refused (ECONNREFUSED)',
    )
  })

  it('renders an object error as JSON', () => {
    expect(formatFailure(fail({ reason: 'bad' }, 'msg'))).toBe('{"reason":"bad"}: msg')
  })
})
