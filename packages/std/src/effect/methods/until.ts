import { asFailure } from 'std:result'

import type { Operation } from '../types/operation'

import { action } from './action'

export const until = <T>(promise: Promise<T>, cause?: string): Operation<T> =>
  action((resolve, reject) => {
    promise.then(resolve).catch(error => {
      reject(asFailure(error, cause))
    })
    return () => {}
  }, cause)
