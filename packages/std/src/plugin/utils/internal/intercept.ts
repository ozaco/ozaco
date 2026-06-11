import type { Operation } from 'std:effect'
import { appendCauses, asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

export function* intercept(op: AnyType, ...causes: string[]): Operation<unknown> {
  const iter = op[Symbol.iterator]()
  let value: unknown
  let method: 'next' | 'throw' = 'next'

  while (true) {
    let step: IteratorResult<AnyType>

    try {
      step = method === 'next' ? iter.next(value) : iter.throw!(value)
    } catch (error) {
      const failure = asFailure(error)

      throw causes.length > 0 ? appendCauses(failure, ...causes) : failure
    }

    if (step.done) {
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
}
