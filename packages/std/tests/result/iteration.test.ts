import { run } from 'std:effect'
import { fail, isFailure, isSuccess, succeed, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('results as generator instructions', () => {
  it('a success iterator returns its value immediately; a failure yields itself', () => {
    const successStep = succeed('done')[Symbol.iterator]().next()
    expect(successStep).toEqual({ done: true, value: 'done' })

    const failure = fail('nope')
    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      const failureStep = failure[Symbol.iterator]().next()
      expect(failureStep.done).toBe(false)
      expect(failureStep.value).toBe(failure)
    }
  })

  it('yield* succeed(value) resumes with the value inside run', async () => {
    const outcome = await run(function* () {
      const value = yield* succeed(21)
      const unit = yield* succeed()

      return { value, unit }
    })

    expect(unwrap(outcome)).toEqual({ value: 21, unit: undefined })
  })

  it('yield* fail(...) short-circuits the operation with that failure', async () => {
    const outcome = await run(function* () {
      yield* fail('exploded', 'human readable')

      return 'unreachable'
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('exploded')
    }
  })
})

describe('succeed passes iterators through as values', () => {
  it('a generator handed to succeed is returned uniterated', async () => {
    let advanced = false
    function* source() {
      advanced = true
      yield 1
    }
    const generator = source()

    const outcome = await run(function* () {
      const passed = yield* succeed(generator)

      return passed === generator
    })

    expect(unwrap(outcome)).toBe(true)
    expect(advanced).toBe(false)
  })

  it('iterables like arrays come back by reference, not consumed', async () => {
    const list = [1, 2, 3]

    const outcome = await run(function* () {
      return yield* succeed(list)
    })

    expect(unwrap(outcome)).toBe(list)
    expect(list).toEqual([1, 2, 3])
  })

  it('thenables are stored as-is — succeed never runs a promise', () => {
    const eventual = Promise.resolve('later')
    const outcome = succeed(eventual)

    expect(isSuccess(outcome)).toBe(true)
    expect(unwrap(outcome)).toBe(eventual)
  })
})
