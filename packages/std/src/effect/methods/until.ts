import type { Operation } from '../types/operation'

import { action } from './action'

export const until = <T>(promise: Promise<T>): Operation<T> =>
  action((resolve, reject) => {
    promise.then(resolve).catch(reject)
    return () => {}
  })
