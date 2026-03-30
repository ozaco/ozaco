import type { Operation } from '../types/operation'

export const lift =
  <TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => TReturn,
  ): ((...args: TArgs) => Operation<TReturn>) =>
  (...args: TArgs) => ({
    // oxlint-disable-next-line require-yield
    *[Symbol.iterator]() {
      return fn(...args)
    },
  })
