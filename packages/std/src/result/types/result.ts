import type { AnyType } from 'std:shared'

import type { RESULT_FAILURE, RESULT_SUCCESS } from '../const'

export type Result<T, E = unknown> = Result.Success<T> | Result.Failure<E>

export namespace Result {
  /** One cause of a failure: a domain string, or a Failure it wraps. */
  export type Cause = string | Failure<unknown>

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
    /** Why it failed, in the order given: domain cause strings, and the Failures it wraps (kept as
     * the SAME object: identity is what std:trace's record-once keys on). */
    readonly causes: Cause[]
    /** Creation time as a `Date.now()` epoch-millisecond stamp, set by `fail()`; diagnostic only. */
    readonly _d: number
    /** The foreign value (a thrown JS / platform / third-party error) this failure was folded
     * from — the caller's to inspect. Only `asFailure` sets it (and reads it back, to re-classify
     * a `std:result.unknown` fold); std itself never renders, sends or classifies by it. */
    readonly raw?: unknown

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
}
