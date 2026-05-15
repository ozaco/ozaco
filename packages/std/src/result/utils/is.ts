import { MAYBE_JUST, MAYBE_NOTHING, RESULT_FAILURE, RESULT_SUCCESS } from '../const'
import type { Maybe } from '../types/maybe'
import type { Result } from '../types/result'

export const isSuccess = <T>(value: unknown): value is Result.Success<T> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === RESULT_SUCCESS

export const isFailure = <E>(value: unknown): value is Result.Failure<E> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === RESULT_FAILURE

export const isResult = <T, E>(value: unknown): value is Result<T, E> =>
  typeof value === 'object' &&
  value !== null &&
  '_t' in value &&
  (value._t === RESULT_SUCCESS || value._t === RESULT_FAILURE)

export const isJust = <T>(value: unknown): value is Maybe.Just<T> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === MAYBE_JUST

export const isNothing = <T>(value: unknown): value is Maybe.Nothing<T> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === MAYBE_NOTHING

export const isMaybe = <T>(value: unknown): value is Maybe<T> =>
  typeof value === 'object' &&
  value !== null &&
  '_t' in value &&
  (value._t === MAYBE_JUST || value._t === MAYBE_NOTHING)
