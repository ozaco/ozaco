import type { Operation } from 'std:effect'
import { appendCauses, asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

export function* intercept(op: AnyType, ...causes: string[]): Operation<unknown> {
  const iter = op[Symbol.iterator]()
  let value: unknown
  let method: 'next' | 'throw' = 'next'
  let completed = false

  try {
    while (true) {
      let step: IteratorResult<AnyType>

      try {
        step = method === 'next' ? iter.next(value) : iter.throw!(value)
      } catch (error) {
        const failure = asFailure(error)

        throw causes.length > 0 ? appendCauses(failure, ...causes) : failure
      }

      if (step.done) {
        completed = true
        return step.value
      }

      try {
        value = yield step.value
        method = 'next'
      } catch (error) {
        value = error
        method = 'throw'
      }
    }
  } finally {
    // this driver runs `op`'s iterator by hand (to append cause tags on throw), so — unlike `yield*` —
    // an early return/halt of THIS generator does NOT auto-propagate `return()` to `op`. Forward it so
    // the wrapped action/hook's own try/finally cleanup runs; drive any effectful cleanup it yields.
    if (!completed && iter.return) {
      let result = iter.return()
      while (!result.done) {
        result = iter.next(yield result.value)
      }
    }
  }
}
