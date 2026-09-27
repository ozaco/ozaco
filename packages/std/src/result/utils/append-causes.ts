import type { AnyType } from 'std:shared'
import { isPromise } from 'std:shared'

import { causesOf } from '../internal/failure'
import type { ResultDef } from '../types/def'

import { isFailure } from './is'

/**
 * Append `causes` to a Failure IN PLACE (the same object comes back), normalized as `fail` does:
 * a string stays, a Failure is nested as is, a Success / `null` / `undefined` is dropped. A
 * Success (or a non-Result) passes through untouched; a promise of either settles to it.
 */
export const appendCauses: ResultDef.AppendCauses = (result, ...causes): AnyType => {
  const apply = (r: AnyType) => {
    if (isFailure(r)) {
      r.causes.push(...causesOf(causes, r))
    }

    return r
  }

  return isPromise(result) ? result.then(apply) : apply(result)
}
