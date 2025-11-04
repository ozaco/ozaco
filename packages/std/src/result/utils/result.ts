import { type BlobType, isPromise } from 'std:shared'

import { RESULT_ERR, RESULT_OK } from '../const'
import type { Err, Ok, Result, ResultAsync } from '../types'

export const ok = <Type>(value: Type): Ok<Type> => {
  return {
    _t: RESULT_OK,
    _v: value,
    // biome-ignore lint/correctness/useYield: Redundant
    *[Symbol.iterator]() {
      return this._v
    },
  }
}

export function err<Name extends string>(name: Name, message: string, cause?: string[]): Err<Name>
export function err(name: string, message: string, cause: string[] = []) {
  return {
    _c: cause,
    _d: Date.now(),
    _m: message,
    _n: name,
    _t: RESULT_ERR,

    *[Symbol.iterator]() {
      // biome-ignore lint/complexity/noUselessThisAlias: Redundant
      const self = this
      yield self
      return self
    },
  }
}

export function auto<Value extends Result<BlobType, BlobType>>(value: Value): Value
export function auto<Value extends BlobType>(value: Value): Ok<Value>
export function auto(value: BlobType) {
  if (isResult(value)) {
    return value
  }
  return ok(value)
}

export const unexpected = (error: Error, cause: string[] = []): Err<'ERR_UNEXPECTED'> => {
  const result = err('ERR_UNEXPECTED', error.message, cause)

  result._o = error

  return result
}

export function isOk<Value>(result: Ok<Value>): result is Ok<Value>
export function isOk(result: unknown): result is Ok<unknown>
export function isOk(result: unknown): result is Ok<unknown> {
  return (result as BlobType)?._t === RESULT_OK
}

export function isErr<Name extends string>(result: Err<Name>): result is Err<Name>
export function isErr(result: unknown): result is Err<string>
export function isErr(result: unknown): result is Err<string> {
  return (result as BlobType)?._t === RESULT_ERR
}

export function isResult<Value, Name extends string>(result: Result<Value, Name>): result is Result<Value, Name>
export function isResult(result: unknown): result is Result<unknown, string>
export function isResult(result: unknown): result is Result<unknown, string> {
  return isOk(result) || isErr(result)
}

export function unwrap<Value, Name extends string>(result: ResultAsync<Value, Name>): PromiseLike<Value>
export function unwrap<Value>(result: Ok<Value>): Value
export function unwrap<Name extends string>(result: Err<Name>): never
export function unwrap<Value, Name extends string>(result: Result<Value, Name>): Value
export function unwrap<Value>(result: Value): Value
export function unwrap(result: BlobType) {
  if (isPromise(result)) return result.then(v => unwrap(v))

  if (isErr(result)) throw result
  if (isOk(result)) return result._v
  return result
}
