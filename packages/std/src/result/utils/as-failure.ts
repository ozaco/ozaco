import type { AnyType } from 'std:shared'
import { serializeError } from 'std:shared'

import type { Impl } from '../types/impl'

import { appendCauses } from './append-causes'
import { fail } from './fail'
import { isFailure } from './is'

export const asFailure: Impl.AsFailure = (error: unknown, ...causes: unknown[]): AnyType => {
  const failure = isFailure(error) ? error : fail(error)

  return appendCauses(failure, ...(causes as string[]))
}

export const asFailureFrom: Impl.AsFailure = (error: unknown, ...causes: unknown[]): AnyType => {
  const failure = isFailure(error) ? error : fail(serializeError(error))

  return appendCauses(failure, ...(causes as string[]))
}
