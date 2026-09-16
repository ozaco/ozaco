import type { AnyType, IsPromiseStrict } from 'std:shared'

import type { Maybe } from './maybe'
import type { Result } from './result'

/** The function shapes of the result module: what `succeed`, `fail`, `auto`, `throwable`,
 * `appendCauses`, `unwrap`, `just`, `nothing` and `asFailure*` are typed as. */
export namespace ResultDef {
  export interface Succeed {
    (): Result.Success<void>

    <T extends `${string}`>(value: T): Result.Success<T>
    <const T>(value: T): Result.Success<T>
  }

  export interface Fail {
    (): Result.Failure<never>

    <E extends `${string}`>(error: E): Result.Failure<E>
    <const E>(error: E, message?: string, ...causes: string[]): Result.Failure<E>
  }

  export interface Auto {
    <R extends Result<AnyType, AnyType>>(
      result: R,
    ): Result<Result.InferSuccess<R>, Result.InferFailure<R>>
    /** a failing `result` yields `defaultValue` — itself a Result when one is given (a Failure
     * default flows out as that Failure), else wrapped as a Success. */
    <R extends Result<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): Result.FromUnion<Result.InferSuccess<R> | T>

    <T extends `${string}`>(value: T): Result<T, never>
    <const T>(value: T): Result.FromUnion<T>
  }

  export interface Throwable {
    /** an async callback: the promise settles to a `Result` — the rejection becomes the Failure. */
    <T, E extends Result.ErrorConstructor = Result.ErrorConstructor>(
      cb: () => Promise<T>,
      errorClass?: E,
      ...causes: string[]
    ): Promise<Result.FromUnion<T | Result.Failure<E['prototype']>>>

    <R, E extends Result.ErrorConstructor = Result.ErrorConstructor>(
      cb: () => R,
      errorClass?: E,
      ...causes: string[]
    ): Result.FromUnion<R | Result.Failure<E['prototype']>>
  }

  export type AppendCauses = <T extends Result<AnyType, AnyType>>(
    result: T,
    ...causes: string[]
  ) => T

  export interface Unwrap {
    <R extends Result<never, AnyType>>(result: R): never

    <R extends Result<AnyType, AnyType> | PromiseLike<Result<AnyType, AnyType>>>(
      result: R,
    ): true extends IsPromiseStrict<R>
      ? Promise<Result.InferSuccess<Awaited<R>>>
      : Result.InferSuccess<Awaited<R>>
    <R extends Result<AnyType, AnyType> | PromiseLike<Result<AnyType, AnyType>>, T>(
      result: R,
      defaultValue: T,
    ): true extends IsPromiseStrict<R>
      ? Promise<Result.InferSuccess<Awaited<R>> | T>
      : Result.InferSuccess<Awaited<R>> | T
  }

  export interface Just {
    (): Maybe<void>
    <T>(value: T): Maybe<T>
    <T>(value?: T | undefined): Maybe<T | undefined>
  }

  export type Nothing = <T = void>() => Maybe<T>

  export interface AsFailure {
    <E>(error: Result.Failure<E>, ...causes: string[]): Result.Failure<E>
    (error: unknown, ...causes: string[]): Result.Failure<unknown>
  }
}
