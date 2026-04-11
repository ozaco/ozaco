import { appendCauses, fail, isFailure } from 'std:result'

import type { Operation } from '../types/operation'

import { action } from './action'

export const until = <T>(promise: Promise<T>, cause = 'until'): Operation<T> =>
  action((resolve, reject) => {
    promise.then(resolve).catch(error => {
      const failure = isFailure(error) ? error : fail(error)

      reject(appendCauses(failure, cause))
    })
    return () => {}
  }, cause)
