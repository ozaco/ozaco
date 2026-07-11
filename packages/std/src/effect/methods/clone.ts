import type { Operation } from '../types/operation'

export const clone = <T>(op: Operation<T>): Operation<T> => ({
  [Symbol.iterator]: () => op[Symbol.iterator](),
})
