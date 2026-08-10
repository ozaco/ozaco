import { run } from 'std:effect'
import { fail, isFailure, isSuccess, succeed, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('simple value/result cases', () => {
  it('raw value return', async () => {
    const outcome = await run(function* () {
      return 42
    })

    expect(isSuccess(outcome)).toBe(false)
    expect(unwrap(outcome)).toBe(42)
  })

  it('yield success', async () => {
    const outcome = await run(function* () {
      return yield* succeed(42)
    })

    expect(isSuccess(outcome)).toBe(false)
    expect(unwrap(outcome)).toBe(42)
  })

  it('success return', async () => {
    const outcome = await run(function* () {
      return succeed(42)
    })

    expect(isSuccess(outcome)).toBe(true)
    expect(unwrap(unwrap(outcome))).toBe(42)
  })

  it('yield failure', async () => {
    const outcome = await run(function* () {
      yield* fail(42, 'sa')
    })

    expect(isFailure(outcome)).toBe(true)
  })

  it('failure return', async () => {
    const outcome = await run(function* () {
      return fail(42, 'sa')
    })

    expect(isFailure(outcome)).toBe(true)
  })
})
