import type { Operation } from '../types/operation'

import { action } from './action'

export function lift<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => Operation<TReturn> {
  return (...args: TArgs) =>
    action((resolve, reject) => {
      try {
        resolve(fn(...args))
      } catch (error) {
        reject(error as Error)
      }
      return () => {}
    })
}
