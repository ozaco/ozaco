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
export type ResultAsync<Type, Name extends string> = PromiseLike<Result<Type, Name>> & {
  [Symbol.asyncIterator](): AsyncGenerator<Err<Name>, Type>
}
