import type { Impl } from '../types'

export const pipe: Impl.Pipe = (value: unknown, ...functions: ((value: unknown) => unknown)[]) => {
  let next = value

  for (const func of functions) {
    next = func(next)
  }

  return next
}
