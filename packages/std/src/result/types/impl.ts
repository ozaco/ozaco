import type { BlobType, HasPromise } from 'std:shared'

import type { Pipe as $Pipe } from './internal/pipe'

import type { InferFailure, InferSuccess, Result, ResultAsync, ResultFor, ResultMaybeAsync } from './result'

export namespace Impl {
  export interface Succeed {
    (): ResultFor<never, void, never>
    <const T>(value: T): ResultFor<T, Awaited<T>, never>
  }

  export interface Fail {
    (): ResultFor<never, never, void>
    <const E>(error: E): ResultFor<E, never, Awaited<E>>
    <const E>(error: E, message: string): ResultFor<E, never, Awaited<E>>
    <const E>(error: E, message: string, ...causes: string[]): ResultFor<E, never, Awaited<E>>
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
    ): (result: R1) => ResultFor<R1, T2, InferFailure<R1>>
    <T1, const T2>(
      fn: (a: T1) => T2,
    ): <R1 extends ResultMaybeAsync<T1, BlobType>>(result: R1) => ResultFor<R1, T2, InferFailure<R1>>
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
    <T>(value: Promise<T>): ResultAsync<Awaited<T>, never>
    <const T>(value: T): Result<T, never>
  }

  export type Guard = <Args extends BlobType[], R>(
    fn: (...args: Args) => R,
    ...causes: string[]
  ) => (
    ...args: Args
  ) => R extends ResultMaybeAsync<infer T, infer E>
    ? true extends HasPromise<R>
      ? ResultAsync<T, E>
      : Result<T, E>
    : ResultFor<R, Awaited<R>, never>
}
