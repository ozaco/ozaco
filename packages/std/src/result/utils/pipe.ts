import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'

export const pipe: Impl.Pipe = (value: unknown, ...functions: ((value: unknown) => unknown)[]) => {
  let next: BlobType = value

  for (const func of functions) {
    next = isPromise(next) ? next.then(func) : func(next)
  }

  return next
}
