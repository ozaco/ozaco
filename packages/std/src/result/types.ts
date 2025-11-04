import type { RESULT_ERR, RESULT_OK } from './const'

export type Ok<Type> = {
  _t: typeof RESULT_OK
  _v: Type
  [Symbol.iterator](): Generator<never, Type>
}
export type Err<Name extends string> = {
  _t: typeof RESULT_ERR
  _n: Name
  _m: string
  _c: string[]
  _d: number
  _o?: Error

  [Symbol.iterator](): Generator<Err<Name>, never>
}

export type Result<Type, Name extends string> = Ok<Type> | Err<Name>

export type BaseResultAsync<Type, Name extends string> = PromiseLike<Result<Type, Name>> & {
  [Symbol.asyncIterator](): AsyncGenerator<Err<Name>, Type>
}
export type ResultAsync<Type, Name extends string> = (Type extends never
  ? Name extends never
    ? never
    : BaseResultAsync<Type, Name>
  : BaseResultAsync<Type, Name>) & {}

export type ResultBoth<Type, Name extends string> = Result<Type, Name> | ResultAsync<Type, Name>

export type ExtractResultAsync<Value, Name extends string> = PromiseLike<
  ResultBoth<PromiseLike<Value> | Value | Err<Name>, Name> | PromiseLike<Value> | Value | Err<Name>
>

export type ExtractResult<Value, Name extends string> = Result<Value | Err<Name>, Name> | Value | Err<Name>

export type ExtractResultBoth<Value, AsyncValue, Name extends string, AsyncName extends string> =
  | ResultAsync<Result<AsyncValue, AsyncName> | PromiseLike<AsyncValue> | AsyncValue | Err<AsyncName>, AsyncName>
  | Result<PromiseLike<AsyncValue> | Value | Err<Name>, Name>
  | PromiseLike<AsyncValue | Result<AsyncValue, AsyncName>>
  | Value
  | Err<Name>
