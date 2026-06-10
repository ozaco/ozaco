import { MAYBE_JUST, MAYBE_NOTHING, RESULT_FAILURE, RESULT_SUCCESS } from '../const'
import type { Maybe } from '../types/maybe'
import type { Result } from '../types/result'

export const isSuccess = (value: unknown): value is Result.Success<unknown> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === RESULT_SUCCESS

export const isFailure = (value: unknown): value is Result.Failure<unknown> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === RESULT_FAILURE

export const isResult = (value: unknown): value is Result<unknown, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  '_t' in value &&
  (value._t === RESULT_SUCCESS || value._t === RESULT_FAILURE)

export const isJust = (value: unknown): value is Maybe.Just<unknown> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === MAYBE_JUST

export const isNothing = (value: unknown): value is Maybe.Nothing<unknown> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === MAYBE_NOTHING

export const isMaybe = (value: unknown): value is Maybe<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  '_t' in value &&
  (value._t === MAYBE_JUST || value._t === MAYBE_NOTHING)
