import type { AnyFunction, AnyType } from 'std:shared'
import { isPromise } from 'std:shared'

import type { Pipe } from '../types/pipe'

export const pipe: Pipe = (value: unknown, ...functions: AnyFunction[]) => {
  let next: AnyType = value

  for (const func of functions) {
    next = isPromise(next) ? next.then(func) : (func as AnyType)(next)
  }

  return next
}
