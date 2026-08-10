import type { AnyType, IsPromiseStrict } from 'std:shared'

import type { Maybe } from './maybe'
import type { Result } from './result'

export namespace Impl {
  export interface Succeed {
    (): Result<void, never>

    <T extends `${string}`>(value: T): Result<T, never>
    <const T>(value: T): Result<T, never>
  }

  export interface Fail {
    (): Result<never, void>

    <E extends `${string}`>(error: E): Result<never, E>
    <const E>(error: E, message?: string, ...causes: string[]): Result<never, E>
  }

  export interface Auto {
    <R extends Result<AnyType, AnyType>>(
      result: R,
    ): Result<Result.InferSuccess<R>, Result.InferFailure<R>>
    <R extends Result<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): Result<Result.InferSuccess<R> | T, never>

    <T extends `${string}`>(value: PromiseLike<T>): Result<T, never>
    <T extends `${string}`>(value: T): Result<T, never>
    <const T>(value: T): Result.FromUnion<T>
  }

  export type Throwable = <R, E extends Result.ErrorConstructor>(
    cb: () => R,
    errorClass?: E,
    ...causes: string[]
  ) => Result.FromUnion<R | Result.Failure<E['prototype']>>

  export type AppendCauses = <T extends Result<AnyType, AnyType>>(
    result: T,
    ...causes: string[]
  ) => T

  export interface Unwrap {
    <R extends Result<never, AnyType>>(result: R): never

    <R extends Result<AnyType, AnyType>>(
      result: R,
    ): true extends IsPromiseStrict<R> ? Promise<Result.InferSuccess<R>> : Result.InferSuccess<R>
    <R extends Result<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): true extends IsPromiseStrict<R>
      ? Promise<Result.InferSuccess<R> | T>
      : Result.InferSuccess<R> | T
  }

  export interface Just {
    (): Maybe<void>
    <T>(value: T): Maybe<T>
    <T>(value?: T | undefined): Maybe<T | undefined>
  }

  export type Nothing = <T = void>() => Maybe<T>

  export interface AsFailure {
    <E>(error: Result.Failure<E>, cause?: string): Result.Failure<E>
    (error: unknown, cause?: string): Result.Failure<unknown>
  }
}
