import type { AnyType } from 'std:shared'
import { isPromise } from 'std:shared'

import type { Impl } from '../types/impl'

import { isFailure } from './is'

export const appendCauses: Impl.AppendCauses = (result, ...causes): AnyType => {
  const apply = (r: AnyType) => {
    if (isFailure(r)) {
      r.causes.push(...causes)
    }

    return r
  }

  return isPromise(result) ? result.then(apply) : apply(result)
}
