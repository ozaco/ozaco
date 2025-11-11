import type { BlobType, HasPromise, IsPromise } from 'std:shared'

import type { RESULT_FAILURE, RESULT_SUCCESS } from '../const'

import type { Helpers } from './helpers'

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

export type Result<T, E> = Success<T> | Failure<E>

export type ResultAsync<T, E> = Promise<Result<T, E>>

export type ResultMaybeAsync<T, E> = ResultAsync<T, E> | Result<T, E>

export type ResultFor<R, T, E> = true extends HasPromise<R> ? ResultAsync<T, E> : Result<T, E>

export type ResultFromUnion<R> = Helpers.UnionToResultFor<IsPromise<R>, Helpers.UnionToResult<Awaited<R>>>

export type InferSuccess<T> = [
  T,
] extends [
  (...args: BlobType[]) => ResultMaybeAsync<infer U, BlobType>,
]
  ? U
  : [
        T,
      ] extends [
        ResultMaybeAsync<infer U, BlobType>,
      ]
    ? U
    : never

export type InferFailure<T> = [
  T,
] extends [
  (...args: BlobType[]) => ResultMaybeAsync<BlobType, infer U>,
]
  ? U
  : [
        T,
      ] extends [
        ResultMaybeAsync<BlobType, infer U>,
      ]
    ? U
    : never
