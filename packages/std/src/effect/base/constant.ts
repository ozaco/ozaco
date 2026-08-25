import type { Operation } from '../types/operation'

/** Create an {@link Operation} that always evaluates to `value`. */
export const constant = <T>(value: T): Operation<T> => ({
  [Symbol.iterator]: () => ({ next: () => ({ done: true as const, value }) }),
})
