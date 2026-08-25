import type { Result } from 'std:result'

import { box } from '../base/box'
import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

import { all } from './all'

/**
 * Run every operation concurrently and evaluate to an array of `Result`s, one per operation —
 * congruent with `Promise.allSettled()`: individual failures do not halt the others.
 */
export function* allSettled<T extends readonly Operation<unknown>[] | []>(
  ops: T,
): Operation<Utils.AllSettled<T>> {
  const results = yield* all(
    ops.map(operation => box(() => operation)) as {
      [P in keyof T]: Operation<Result<Utils.Yielded<T[P]>>>
    },
  )
  return results as Utils.AllSettled<T>
}
