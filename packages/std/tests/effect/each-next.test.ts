/**
 * `each.next()` is a plain generator-backed `Operation<void>` — nothing on it beyond the
 * contract — and it is re-entrant: every call advances the innermost iteration.
 */
import { attempt, each, flowOf, run } from 'std:effect'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('each.next()', () => {
  it('carries no extra fields and drives the loop', async () => {
    const op = each.next()
    expect(Object.keys(op)).toEqual([])
    expect(typeof op[Symbol.iterator]).toBe('function')

    unwrap(
      await run(function* () {
        const seen: number[] = []
        const flow = flowOf<number>(function* (emit) {
          yield* emit(1)
          yield* emit(2)
          yield* emit(3)
        })

        for (const value of yield* each(flow)) {
          seen.push(value)
          yield* each.next()
        }

        expect(seen).toEqual([1, 2, 3])
      }),
    )
  })

  it('with no iteration ever opened in the scope it fails std:effect.missing-context', async () => {
    unwrap(
      await run(function* () {
        const never = yield* attempt(() => each.next())
        expect(isFailure(never) && never.error).toBe('std:effect.missing-context')
      }),
    )
  })
})
