import { RESULT_FAILURE, RESULT_SUCCESS } from '../const'
import type { Failure, Result, Success } from '../types'

export const isSuccess = <T>(result: Result<T, unknown>): result is Success<T> => {
  return result && result._t === RESULT_SUCCESS
}

export const isFailure = <E>(result: Result<unknown, E>): result is Failure<E> => {
  return result && result._t === RESULT_FAILURE
}

export const isResult = <T, E>(result: unknown): result is Result<T, E> => {
  return (
    typeof result === 'object' &&
    result !== null &&
    '_t' in result &&
    (result._t === RESULT_SUCCESS || result._t === RESULT_FAILURE)
  )
}
