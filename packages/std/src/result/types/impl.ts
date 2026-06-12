import type { AnyType, IsPromiseStrict } from 'std:shared'

import type { Maybe } from './maybe'
import type { Result } from './result'

export namespace Impl {
  export interface Succeed {
    (): Result<void, never>

    <T extends `${string}`>(value: PromiseLike<T>): Result.Async<T, never>
    <T extends `${string}`>(value: T): Result<T, never>
    <const T>(value: T): Result.For<T, Awaited<T>, never>
  }

  export interface Fail {
    (): Result<never, void>

    <E extends `${string}`>(error: PromiseLike<E>): Result.Async<never, E>
    <E extends `${string}`>(error: E): Result<never, E>
    <const E>(error: E, message?: string, ...causes: string[]): Result.For<E, never, Awaited<E>>
  }

  export interface Auto {
    <R extends Result.Both<AnyType, AnyType>>(
      result: R,
    ): true extends IsPromiseStrict<R>
      ? Result.Async<Result.InferSuccess<R>, Result.InferFailure<R>>
      : Result<Result.InferSuccess<R>, Result.InferFailure<R>>
    <R extends Result.Both<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): true extends IsPromiseStrict<R>
      ? Result.Async<Result.InferSuccess<R> | T, never>
      : Result<Result.InferSuccess<R> | T, never>

    <const T>(): (value: T) => Result.ResultFromUnion<T>

    <T extends `${string}`>(value: PromiseLike<T>): Result.Async<T, never>
    <T extends `${string}`>(value: T): Result<T, never>
    <const T>(value: T): Result.ResultFromUnion<T>
  }

  export type Throwable = <R, E extends Result.ErrorConstructor>(
    cb: () => R,
    errorClass?: E,
    ...causes: string[]
  ) => Result.ResultFromUnion<R | Result.Failure<E['prototype']>>

  export interface AppendCauses {
    <T extends Result.Both<AnyType, AnyType>>(result: T, ...causes: string[]): T
    <T extends Result.Both<AnyType, AnyType>>(...causes: string[]): (result: T) => T
  }

  export interface Unwrap {
    <R extends Result.Both<never, AnyType>>(result: R): never

    <R extends Result.Both<AnyType, AnyType>>(
      result: R,
    ): true extends IsPromiseStrict<R> ? Promise<Result.InferSuccess<R>> : Result.InferSuccess<R>
    <R extends Result.Both<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): true extends IsPromiseStrict<R>
      ? Promise<Result.InferSuccess<R> | T>
      : Result.InferSuccess<R> | T
    <R extends Result.Both<AnyType, AnyType>>(): (
      result: R,
    ) => true extends IsPromiseStrict<R> ? Promise<Result.InferSuccess<R>> : Result.InferSuccess<R>
    <R extends Result.Both<AnyType, AnyType>, T>(
      defaultValue: T,
    ): (
      result: R,
    ) => true extends IsPromiseStrict<R>
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
