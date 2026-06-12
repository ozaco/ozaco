import type { AnyType, IsPromise, IsPromiseStrict } from 'std:shared'

import type { RESULT_FAILURE, RESULT_SUCCESS } from '../const'

export type Result<T, E> = Result.Success<T> | Result.Failure<E>

export namespace Result {
  export type Success<T> = {
    readonly _t: typeof RESULT_SUCCESS
    readonly value: T

    [Symbol.iterator](): Generator<never, T>
  }

  export type Failure<E> = {
    readonly _t: typeof RESULT_FAILURE
    readonly error: E

    readonly message: string
    readonly causes: string[]
    readonly _d: number

    [Symbol.iterator](): Generator<Failure<E>, never>
  }

  // oxlint-disable-next-line typescript/no-empty-object-type
  export interface Async<T, E> extends Promise<Result<T, E>> {}

  export type Both<T, E> = Result.Async<T, E> | Result<T, E>

  export type For<R, T, E> = true extends IsPromiseStrict<R> ? Result.Async<T, E> : Result<T, E>

  export type InferSuccess<T> = [T] extends [(...args: AnyType[]) => Result.Both<infer U, AnyType>]
    ? U
    : [T] extends [Result.Both<infer U, AnyType>]
      ? U
      : never

  export type InferFailure<T> = [T] extends [(...args: AnyType[]) => Result.Both<AnyType, infer U>]
    ? U
    : [T] extends [Result.Both<AnyType, infer U>]
      ? U
      : never

  export type FromUnion<R> = R extends Result<AnyType, AnyType> ? R : Result<R, never>

  export type FromUnionFor<P, R> = true extends P
    ? Result.Async<InferSuccess<R>, InferFailure<R>>
    : Result<InferSuccess<R>, InferFailure<R>>

  export type ResultFromUnion<R> = Result.FromUnionFor<IsPromise<R>, Result.FromUnion<Awaited<R>>>

  export interface ErrorConstructor<E = Error> {
    new (error: Error): E
    readonly prototype: E
  }
}
