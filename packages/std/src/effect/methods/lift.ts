import type { Operation } from '../types/operation'

import { action } from './action'

export const lift =
  <TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => TReturn,
  ): ((...args: TArgs) => Operation<TReturn>) =>
  (...args: TArgs) =>
    action((resolve, reject) => {
      try {
        resolve(fn(...args))
      } catch (error) {
        reject(error)
      }
      return () => {}
    })
