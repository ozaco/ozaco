import type { BlobType, HasPromise } from 'std:shared'

import type { Pipe as $Pipe } from './internal/pipe'

import type {
  Failure,
  InferFailure,
  InferSuccess,
  Result,
  ResultAsync,
  ResultFor,
  ResultFromUnion,
  ResultMaybeAsync,
} from './result'

export namespace Impl {
  export interface Succeed {
    (): ResultFor<never, void, never>

    <T extends `${string}`>(value: Promise<Awaited<T>> | Promise<T>): ResultFor<true, T, never>
    <T extends `${string}`>(value: T): ResultFor<false, T, never>
    <const T>(value: T): ResultFor<T, Awaited<T>, never>
  }

  export interface Fail {
    (): ResultFor<never, never, void>

    <E extends `${string}`>(value: Promise<Awaited<E>> | Promise<E>): ResultFor<true, never, E>
    <E extends `${string}`>(value: E): ResultFor<false, never, E>
    <const E>(error: E, message?: string, ...causes: string[]): ResultFor<E, never, Awaited<E>>
  }

  export interface Combine {
    <X extends Record<string, ResultMaybeAsync<BlobType, BlobType>>>(
      x: X,
    ): ResultFor<X[keyof X], { [K in keyof X]: InferSuccess<X[K]> }, InferFailure<X[keyof X]>[]>
    <const X extends Array<ResultMaybeAsync<BlobType, BlobType>>>(
      x: X,
    ): ResultFor<X[number], { [K in keyof X]: InferSuccess<X[K]> }, InferFailure<X[number]>[]>
    <const X extends ReadonlyArray<ResultMaybeAsync<BlobType, BlobType>>>(
      x: X,
    ): ResultFor<X[number], { [K in keyof X]: InferSuccess<X[K]> }, InferFailure<X[number]>[]>
    <const X extends Array<unknown>, Fn extends (value: X[number]) => ResultMaybeAsync<BlobType, BlobType>>(
      x: X,
      fn: Fn,
    ): ResultFor<ReturnType<Fn>, { [K in keyof X]: InferSuccess<Fn> }, InferFailure<Fn>[]>
    <const X extends ReadonlyArray<unknown>, Fn extends (value: X[number]) => ResultMaybeAsync<BlobType, BlobType>>(
      x: X,
      fn: Fn,
    ): ResultFor<ReturnType<Fn>, { [K in keyof X]: InferSuccess<Fn> }, InferFailure<Fn>[]>
  }

  export interface Unwrap {
    <R extends ResultMaybeAsync<BlobType, BlobType>>(
      result: R,
    ): true extends HasPromise<R> ? Promise<InferSuccess<R>> : InferSuccess<R>
    <R extends ResultMaybeAsync<BlobType, BlobType>, T>(
      result: R,
      defaultValue: T,
    ): true extends HasPromise<R> ? Promise<InferSuccess<R> | T> : InferSuccess<R> | T
    <R extends ResultMaybeAsync<BlobType, BlobType>>(): (
      result: R,
    ) => true extends HasPromise<R> ? Promise<InferSuccess<R>> : InferSuccess<R>
    <R extends ResultMaybeAsync<BlobType, BlobType>, T>(
      defaultValue: T,
    ): (result: R) => true extends HasPromise<R> ? Promise<InferSuccess<R> | T> : InferSuccess<R> | T
  }

  export interface Map {
    <R1 extends ResultMaybeAsync<BlobType, BlobType>, const T2>(
      fn: (a: InferSuccess<R1>) => T2,
    ): (result: R1) => ResultFor<R1, InferSuccess<ResultFromUnion<T2>>, InferFailure<R1>>
    <T1, const T2>(
      fn: (a: T1) => T2,
    ): <R1 extends ResultMaybeAsync<T1, BlobType>>(
      result: R1,
    ) => ResultFor<R1, InferSuccess<ResultFromUnion<T2>>, InferFailure<R1>>
  }

  export interface MapError {
    <R1 extends ResultMaybeAsync<BlobType, BlobType>, E2 extends ResultMaybeAsync<BlobType, BlobType>>(
      fn: (a: Failure<InferFailure<R1>>) => E2,
    ): (result: R1) => ResultFor<R1, InferSuccess<R1>, InferFailure<E2>>
    <E1, const E2 extends ResultMaybeAsync<BlobType, BlobType>>(
      fn: (a: E1) => E2,
    ): <R1 extends ResultMaybeAsync<BlobType, E1>>(result: R1) => ResultFor<R1, InferSuccess<R1>, InferFailure<E2>>
  }

  export type Pipe = $Pipe

  export interface Auto {
    <R extends ResultMaybeAsync<BlobType, BlobType>>(
      result: R,
    ): true extends HasPromise<R>
      ? ResultAsync<InferSuccess<R>, InferFailure<R>>
      : Result<InferSuccess<R>, InferFailure<R>>
    <R extends ResultMaybeAsync<BlobType, BlobType>, T>(
      result: R,
      defaultValue: T,
    ): true extends HasPromise<R> ? ResultAsync<InferSuccess<R> | T, never> : Result<InferSuccess<R> | T, never>

    <T extends `${string}`>(value: Promise<Awaited<T>> | Promise<T>): ResultFor<true, T, never>
    <T extends `${string}`>(value: T): ResultFor<false, T, never>
    <const T>(value: T): ResultFromUnion<T>

    <R>(): (result: R) => ResultFromUnion<R>
  }

  export interface Guard {
    <Args extends BlobType[], U, V>(
      fn: (...args: Args) => Generator<U, V>,
      ...causes: string[]
    ): (...args: Args) => ResultFromUnion<V | U>
    <Args extends BlobType[], U, V>(
      fn: (...args: Args) => AsyncGenerator<U, V>,
      ...causes: string[]
    ): (...args: Args) => ResultFromUnion<Promise<V | U>>
    <Args extends BlobType[], R>(fn: (...args: Args) => R, ...causes: string[]): (...args: Args) => ResultFromUnion<R>
  }

  export interface OrElse {
    <R1 extends ResultMaybeAsync<BlobType, BlobType>, R2 extends ResultMaybeAsync<BlobType, BlobType>>(
      fn: (a: Failure<InferFailure<R1>>) => R2,
    ): (result: R1) => ResultFor<R1 | R2, InferSuccess<R1> | InferSuccess<R2>, InferFailure<R2>>
    <F extends (a: BlobType) => ResultMaybeAsync<BlobType, BlobType>>(
      fn: F,
    ): <R1 extends ResultMaybeAsync<BlobType, Parameters<F>[0]>>(
      result: R1,
    ) => ResultFor<R1 | ReturnType<F>, InferSuccess<R1> | InferSuccess<F>, InferFailure<F>>
  }

  export interface AppendCauses {
    <T extends ResultMaybeAsync<BlobType, BlobType>>(result: T, ...causes: string[]): T
    <T extends ResultMaybeAsync<BlobType, BlobType>>(...causes: string[]): (result: T) => T
  }
}
