import type { AnyType } from 'std:shared'
import { isPromise } from 'std:shared'

import type { ResultDef } from '../types/def'

import { asFailure } from './as-failure'
import { auto } from './auto'

/**
 * `cb`'s value as a Result — a returned Result as is — and a throw (for an async `cb`, the
 * rejection) folded by `asFailure`: through the matchers of `tags` when a `createTags` bundle
 * comes first, `causes` appended.
 */
export const throwable: ResultDef.Throwable = ((cb: () => AnyType, ...rest: AnyType[]): AnyType => {
  const folded = (error: unknown) => asFailure(error, ...rest)

  try {
    const result = cb()

    return isPromise(result) ? result.then(auto, folded) : auto(result)
  } catch (error) {
    return folded(error)
  }
}) as ResultDef.Throwable
