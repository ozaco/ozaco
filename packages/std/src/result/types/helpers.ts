import type { AnyType, IsPromise } from 'std:shared'
import type { Result, ResultAsync, ResultBoth } from './result'

export namespace Helpers {
  export type InferSuccess<T> = [T] extends [(...args: AnyType[]) => ResultBoth<infer U, AnyType>]
    ? U
    : [T] extends [ResultBoth<infer U, AnyType>]
      ? U
      : never

  export type InferFailure<T> = [T] extends [(...args: AnyType[]) => ResultBoth<AnyType, infer U>]
    ? U
    : [T] extends [ResultBoth<AnyType, infer U>]
      ? U
      : never

  export type UnionToResult<R> = R extends Result<AnyType, AnyType> ? R : Result<R, never>

  export type UnionToResultFor<P, R> = true extends P
    ? ResultAsync<InferSuccess<R>, InferFailure<R>>
    : Result<InferSuccess<R>, InferFailure<R>>

  export type ResultFromUnion<R> = Helpers.UnionToResultFor<
    IsPromise<R>,
    Helpers.UnionToResult<Awaited<R>>
  >

  export interface ErrorConstructor<E = Error> {
    new (error: Error): E
    readonly prototype: E
  }
}
