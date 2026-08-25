import {
  fail,
  isFailure,
  isJust,
  isMaybe,
  isNothing,
  isResult,
  isSuccess,
  just,
  nothing,
  succeed,
} from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('fail', () => {
  it('builds an empty failure with default message, causes and a timestamp', () => {
    const failure = fail()

    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      expect(failure.message).toBe('')
      expect(failure.causes).toEqual([])
      expect(typeof failure._d).toBe('number')
    }
  })

  it('carries error, message and trailing causes', () => {
    const failure = fail('io-error', 'disk detached', 'while flushing', 'during shutdown')

    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      expect(failure.error).toBe('io-error')
      expect(failure.message).toBe('disk detached')
      expect(failure.causes).toEqual(['while flushing', 'during shutdown'])
    }
  })
})

describe('succeed', () => {
  it('returns the one shared frozen unit when called without a value', () => {
    const first = succeed()
    const second = succeed()

    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(isSuccess(first)).toBe(true)
  })

  it('wraps a value into a fresh success per call', () => {
    const one = succeed({ n: 1 })
    const two = succeed({ n: 1 })

    expect(isSuccess(one)).toBe(true)
    expect(one).not.toBe(two)
    if (isSuccess(one)) {
      expect(one.value).toEqual({ n: 1 })
    }
  })
})

describe('maybe', () => {
  it('just carries a value, nothing does not, both are maybes', () => {
    const some = just('here')
    const none = nothing()

    expect(isJust(some)).toBe(true)
    expect(isNothing(none)).toBe(true)
    expect(isMaybe(some)).toBe(true)
    expect(isMaybe(none)).toBe(true)
    if (isJust(some)) {
      expect(some.value).toBe('here')
    }

    // just() without an argument omits the value property entirely
    const empty = just()
    expect(isJust(empty)).toBe(true)
    expect('value' in empty).toBe(false)
  })
})

describe('guards', () => {
  it('discriminate results, maybes and foreign shapes', () => {
    expect(isResult(succeed(1))).toBe(true)
    expect(isResult(fail('x'))).toBe(true)
    expect(isSuccess(fail('x'))).toBe(false)
    expect(isFailure(succeed(1))).toBe(false)

    expect(isResult(null)).toBe(false)
    expect(isResult(undefined)).toBe(false)
    expect(isResult({ value: 5 })).toBe(false)
    expect(isResult({ _t: 'custom' })).toBe(false)

    // maybes and results never cross-match
    expect(isResult(just(1))).toBe(false)
    expect(isMaybe(succeed(1))).toBe(false)

    // the tag is a registered symbol — structural interop across module copies is intended
    expect(isSuccess({ _t: Symbol.for('std:result:success') })).toBe(true)
  })
})
