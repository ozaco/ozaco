import { ensure, run } from 'std:effect'
import { fail, isFailure, isSuccess, succeed, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('simple value/result cases', () => {
  it('raw value return', async () => {
    let i = 0

    const outcome = await run(function* () {
      yield* ensure(function* () {
        i++
      })

      return 42
    })

    expect(isSuccess(outcome)).toBe(false)
    expect(unwrap(outcome)).toBe(42)
    expect(i).toBe(1)
  })

  it('yield success', async () => {
    let i = 0

    const outcome = await run(function* () {
      yield* ensure(function* () {
        i++
      })

      return yield* succeed(42)
    })

    expect(isSuccess(outcome)).toBe(false)
    expect(unwrap(outcome)).toBe(42)
    expect(i).toBe(1)
  })

  it('success return', async () => {
    let i = 0

    const outcome = await run(function* () {
      yield* ensure(function* () {
        i++
      })

      return succeed(42)
    })

    expect(isSuccess(outcome)).toBe(true)
    expect(unwrap(unwrap(outcome))).toBe(42)
    expect(i).toBe(1)
  })

  it('yield failure', async () => {
    let i = 0

    const outcome = await run(function* () {
      yield* ensure(function* () {
        i++
      })

      yield* fail(42, 'sa')
    })

    expect(isFailure(outcome)).toBe(true)
    expect(i).toBe(1)
  })

  it('failure return', async () => {
    let i = 0

    const outcome = await run(function* () {
      yield* ensure(function* () {
        i++
      })

      return fail(42, 'sa')
    })

    expect(isFailure(outcome)).toBe(true)
    expect(i).toBe(1)
  })
})
