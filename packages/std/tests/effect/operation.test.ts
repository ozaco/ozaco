/**
 * `operation(fn, ...causes)`: a returned `Result` is unwrapped (Success → value, Failure → raise),
 * a plain value passes through, a thrown error is folded into a Failure carrying the causes.
 */
import { attempt, operation, run } from 'std:effect'
import { fail, isFailure, isSuccess, succeed, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('operation()', () => {
  it('unwraps a returned Success and passes a plain value through', async () => {
    unwrap(
      await run(function* () {
        const wrapped = operation(function* () {
          return succeed(5) as unknown as number
        })
        const plain = operation(function* (n: number) {
          return n * 2
        })

        expect(yield* wrapped()).toBe(5)
        expect(yield* plain(4)).toBe(8)
      }),
    )
  })

  it('raises a returned Failure and folds a throw into a Failure with the causes', async () => {
    unwrap(
      await run(function* () {
        const returned = operation(function* () {
          return fail('op.returned', 'as a value') as unknown as number
        }, 'op:cause')
        const thrown = operation(function* () {
          throw new Error('thrown')
        }, 'op:cause')

        const first = yield* attempt(() => returned())
        expect(isFailure(first) && first.error).toBe('op.returned')

        const second = yield* attempt(() => thrown())
        expect(isFailure(second)).toBe(true)
        if (isFailure(second)) {
          expect(second.causes).toContain('op:cause')
        }
      }),
    )
  })

  it('is re-entrant: each call runs the body afresh', async () => {
    unwrap(
      await run(function* () {
        let calls = 0
        const counted = operation(function* () {
          calls += 1
          return calls
        })

        expect(yield* counted()).toBe(1)
        expect(yield* counted()).toBe(2)
        expect(isSuccess(yield* attempt(() => counted()))).toBe(true)
      }),
    )
  })
})
