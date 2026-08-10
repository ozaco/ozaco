import type { AnyType } from 'std:shared'

import type { RESULT_FAILURE, RESULT_SUCCESS } from '../const'

export type Result<T, E = unknown> = Result.Success<T> | Result.Failure<E>

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

  export type InferSuccess<T> = [T] extends [(...args: AnyType[]) => Result<infer U, AnyType>]
    ? U
    : [T] extends [Result<infer U, AnyType>]
      ? U
      : never

  export type InferFailure<T> = [T] extends [(...args: AnyType[]) => Result<AnyType, infer U>]
    ? U
    : [T] extends [Result<AnyType, infer U>]
      ? U
      : never

  export type FromUnion<R> = R extends Result<AnyType, AnyType> ? R : Result<R, never>

  export interface ErrorConstructor<E = Error> {
    new (error: Error): E
    readonly prototype: E
  }
}
