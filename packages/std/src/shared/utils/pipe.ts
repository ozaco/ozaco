import type { AnyFunction, AnyType } from '../types/common'
import type { Pipe } from '../types/pipe'

import { isPromise } from './is'

export const pipe: Pipe = (value: unknown, ...functions: AnyFunction[]) => {
  let next: AnyType = value

  for (const func of functions) {
    next = isPromise(next) ? next.then(func) : (func as AnyType)(next)
  }

  return next
}
