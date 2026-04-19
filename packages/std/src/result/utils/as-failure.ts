import type { AnyType } from 'std:shared'

import type { Impl } from '../types/impl'

import { appendCauses } from './append-causes'
import { fail } from './fail'
import { isFailure } from './is'

export const asFailure: Impl.AsFailure = (error: unknown, cause: unknown) => {
  const failure = isFailure(error) ? error : (fail(error) as AnyType)

  return cause ? appendCauses(failure, cause as string) : failure
}
