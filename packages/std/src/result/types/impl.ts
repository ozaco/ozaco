import type { AnyType, IsPromiseStrict } from 'std:shared'

import type { Failure, Result, ResultAsync, ResultBoth, ResultFor } from './result'
import type { Helpers } from './helpers'

export namespace Impl {
  export interface Succeed {
    (): ResultFor<false, void, never>

    <T extends `${string}`>(value: Promise<Awaited<T>> | Promise<T>): ResultFor<true, T, never>
    <T extends `${string}`>(value: T): ResultFor<false, T, never>
    <const T>(value: T): ResultFor<T, Awaited<T>, never>
  }

  export interface Fail {
    (): ResultFor<false, never, void>

    <E extends `${string}`>(value: Promise<Awaited<E>> | Promise<E>): ResultFor<true, never, E>
    <E extends `${string}`>(value: E): ResultFor<false, never, E>
    <const E>(error: E, message?: string, ...causes: string[]): ResultFor<E, never, Awaited<E>>
  }

  export interface Auto {
    <R extends ResultBoth<AnyType, AnyType>>(
      result: R,
    ): true extends IsPromiseStrict<R>
      ? ResultAsync<Helpers.InferSuccess<R>, Helpers.InferFailure<R>>
      : Result<Helpers.InferSuccess<R>, Helpers.InferFailure<R>>
    <R extends ResultBoth<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): true extends IsPromiseStrict<R>
      ? ResultAsync<Helpers.InferSuccess<R> | T, never>
      : Result<Helpers.InferSuccess<R> | T, never>

    <T extends `${string}`>(value: Promise<Awaited<T>> | Promise<T>): ResultFor<true, T, never>
    <T extends `${string}`>(value: T): ResultFor<false, T, never>
    <const T>(value: T): Helpers.ResultFromUnion<T>
  }

  export type Throwable = <R, E extends Helpers.ErrorConstructor>(
    cb: () => R,
    errorClass?: E,
    ...causes: string[]
  ) => Helpers.ResultFromUnion<R | Failure<E['prototype']>>

  export interface AppendCauses {
    <T extends ResultBoth<AnyType, AnyType>>(result: T, ...causes: string[]): T
    <T extends ResultBoth<AnyType, AnyType>>(...causes: string[]): (result: T) => T
  }

  export interface Unwrap {
    <R extends ResultBoth<AnyType, AnyType>>(
      result: R,
    ): true extends IsPromiseStrict<R> ? Promise<Helpers.InferSuccess<R>> : Helpers.InferSuccess<R>
    <R extends ResultBoth<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): true extends IsPromiseStrict<R>
      ? Promise<Helpers.InferSuccess<R> | T>
      : Helpers.InferSuccess<R> | T
    <R extends ResultBoth<AnyType, AnyType>>(): (
      result: R,
    ) => true extends IsPromiseStrict<R>
      ? Promise<Helpers.InferSuccess<R>>
      : Helpers.InferSuccess<R>
    <R extends ResultBoth<AnyType, AnyType>, T>(
      defaultValue: T,
    ): (
      result: R,
    ) => true extends IsPromiseStrict<R>
      ? Promise<Helpers.InferSuccess<R> | T>
      : Helpers.InferSuccess<R> | T
  }
}
