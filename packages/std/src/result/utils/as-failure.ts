import type { AnyType } from 'std:shared'
import { serializeError } from 'std:shared'

import type { ResultDef } from '../types/def'

import { appendCauses } from './append-causes'
import { fail } from './fail'
import { isFailure } from './is'

export const asFailure: ResultDef.AsFailure = (error: unknown, ...causes: string[]): AnyType => {
  const failure = isFailure(error) ? error : fail(error)

  return appendCauses(failure, ...causes)
}

export const asFailureFrom: ResultDef.AsFailure = (
  error: unknown,
  ...causes: string[]
): AnyType => {
  const failure = isFailure(error) ? error : fail(serializeError(error))

  return appendCauses(failure, ...causes)
}
