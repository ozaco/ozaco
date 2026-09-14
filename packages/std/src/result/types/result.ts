import type { AnyType } from 'std:shared'

import type { RESULT_FAILURE, RESULT_SUCCESS } from '../const'

export type Result<T, E = unknown> = Result.Success<T> | Result.Failure<E>

export namespace Result {
  export type Success<T> = {
    /** Discriminant tag (`RESULT_SUCCESS`); what `isSuccess` / `isResult` check. */
    readonly _t: typeof RESULT_SUCCESS
    readonly value: T

    [Symbol.iterator](): Generator<never, T>
  }

  export type Failure<E> = {
    /** Discriminant tag (`RESULT_FAILURE`); what `isFailure` / `isResult` check. */
    readonly _t: typeof RESULT_FAILURE
    readonly error: E

    readonly message: string
    readonly causes: string[]
    /** Creation time as a `Date.now()` epoch-millisecond stamp, set by `fail()`; diagnostic only. */
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

  // rest-args so both custom `new (error: Error)` classes and built-ins like `SyntaxError`
  // (`new (message?: string)`) satisfy the constraint. Built-ins type-check without a cast
  // (`throwable(cb, SyntaxError)` compiles); the `as AnyType` casts in tests/result/transform.test.ts
  // are not required by this constraint.
  export interface ErrorConstructor<E = Error> {
    new (...args: AnyType[]): E
    readonly prototype: E
  }
}
