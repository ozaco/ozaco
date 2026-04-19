import type { Operation } from '../types/operation'

export const constant = <T>(value: T): Operation<T> => ({
  [Symbol.iterator]: () => ({ next: () => ({ done: true as const, value }) }),
})
