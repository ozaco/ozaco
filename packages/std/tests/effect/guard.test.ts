/**
 * `guard(fn, ...causes)` — the wrapper for generators that want their failures STAMPED: a returned
 * `Result` is unwrapped (Success → value, Failure → raise), a thrown error is folded into a
 * Failure, and every failure leaving the body carries the given causes. Without causes there is
 * nothing to stamp: write a plain generator instead.
 */
import { attempt, guard, run } from 'std:effect'
import { fail, isFailure, isSuccess, succeed, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('guard()', () => {
  it('unwraps a returned Success and passes a plain value through', async () => {
    unwrap(
      await run(function* () {
        const wrapped = guard(function* () {
          return succeed(5) as unknown as number
        }, 'guard:cause')
        const plain = guard(function* (n: number) {
          return n * 2
        }, 'guard:cause')

        expect(yield* wrapped()).toBe(5)
        expect(yield* plain(4)).toBe(8)
      }),
    )
  })

  it('raises a returned Failure and folds a throw into a Failure — both carry the causes', async () => {
    unwrap(
      await run(function* () {
        const returned = guard(function* () {
          return fail('op.returned', 'as a value') as unknown as number
        }, 'op:cause')
        const thrown = guard(function* () {
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
        const counted = guard(function* () {
          calls += 1
          return calls
        }, 'guard:count')

        expect(yield* counted()).toBe(1)
        expect(yield* counted()).toBe(2)
        expect(isSuccess(yield* attempt(() => counted()))).toBe(true)
      }),
    )
  })
})
