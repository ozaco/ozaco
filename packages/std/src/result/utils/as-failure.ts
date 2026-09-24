import type { AnyType } from 'std:shared'
import { serializeError } from 'std:shared'

import { ResultErrors } from '../errors'
import type { ResultDef } from '../types/def'

import { appendCauses } from './append-causes'
import { fail } from './fail'
import { isFailure } from './is'

// an `Error` carries its own text: surface it as the failure's `message` instead of leaving it
// empty (the Error itself stays the `error` / the serialized string, per variant)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '')

export const asFailure: ResultDef.AsFailure = (error: unknown, ...causes: string[]): AnyType => {
  const failure = isFailure(error) ? error : fail(error, messageOf(error))

  return appendCauses(failure, ...causes)
}

export const asFailureFrom: ResultDef.AsFailure = (
  error: unknown,
  ...causes: string[]
): AnyType => {
  const failure = isFailure(error) ? error : fail(ResultErrors.Unknown, serializeError(error))

  return appendCauses(failure, ...causes)
}
