import type { Operation } from '../types/operation'

export const clone = <T, E = never>(op: Operation<T, E>): Operation<T, E> => ({
  [Symbol.iterator]: () => op[Symbol.iterator](),
})
