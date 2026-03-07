import type { HasPromise, IsPromise } from 'std:shared'

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

export interface ResultAsync<T, E> extends Promise<Result<T, E>> {
  [Symbol.iterator](): Promise<Generator<Failure<E>, T>>
  // TODO: asyncIterator
}

export type ResultMaybeAsync<T, E> = ResultAsync<T, E> | Result<T, E>

export type ResultFor<R, T, E> = true extends HasPromise<R> ? ResultAsync<T, E> : Result<T, E>

export type ResultFromUnion<R> = Helpers.UnionToResultFor<
  IsPromise<R>,
  Helpers.UnionToResult<Awaited<R>>
>
