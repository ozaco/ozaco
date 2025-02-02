/// <reference path="../shared/index.ts" />

import type { BlobType, LiteralUnion } from '../shared'

import type { resultTags } from './tag'
import type { ResultAsync as $ResultAsync } from './utils/async'
import type { Err } from './utils/err'
import type { Ok } from './utils/ok'
import type { Tags } from './utils/tag'

declare global {
  /**
   * Std namespace is used to merge types in all projects.
   */
  namespace Std {
    // ------------- Errors -------------

    /**
     * Use this instead of CustomErrors. CustomErrors is for overriding
     */
    interface Error {
      'std/results': typeof resultTags
    }

    type ExtractErrors<T> = T extends Tags<infer U, infer T>
      ? U extends [infer K, never]
        ? K extends string
          ? `${T}.${K}`
          : never
        : `${T}.${U['1']}`
      : never

    /**
     * Shortcut for union intersection of Std.Error values
     */
    type ErrorValues = LiteralUnion<Std.ExtractErrors<Std.Error[keyof Std.Error]>, `?${string}`>

    // ------------- Shortcuts -------------

    /**
     * Resolves the Ok type from a Err or nested Ok
     */
    type OkResolver<T> = T extends Err<BlobType, BlobType, BlobType>
      ? T
      : Ok<T extends Ok<infer T2, never, []> ? T2 : T, never, []>

    /**
     * Infers the T type from a Result<T, N, C>
     */
    type InferOkType<R> = R extends Std.Result<infer T, BlobType, BlobType[]>
      ? T
      : R extends ResultAsync<infer T, BlobType>
        ? T
        : never
    /**
     * Infers the N type from a Result<T, N, C>
     */
    type InferNameType<R> = R extends Err<BlobType, infer N, BlobType[]> ? N : never
    /**
     * Infers the C type from a Result<T, N, C>
     */
    type InferCauseType<R> = R extends Err<BlobType, BlobType, infer C> ? C : []

    /**
     * Shortcut for generating both Ok and Err
     */
    type Result<T, N extends Std.ErrorValues = never, C extends Std.ErrorValues[] = []> =
      | Ok<T, N, C>
      | Err<T, N, C>

    /**
     * Shortcut for ResultAsync
     */
    type ResultAsync<
      T,
      N extends Std.ErrorValues = never,
      C extends Std.ErrorValues[] = [],
    > = $ResultAsync<T, N, C>

    /**
     * Shortcut for both Result and ResultAsync
     */
    type Both<T, N extends Std.ErrorValues = never, C extends Std.ErrorValues[] = []> =
      | Std.Result<T, N, C>
      | Std.ResultAsync<T, N, C>

    /**
     * Basic implementation of a Result
     */
    interface ResultType<T, N extends Std.ErrorValues = never, C extends Std.ErrorValues[] = []> {
      /**
       * Used to check if a `Result` is an `OK`
       *
       * @returns `true` if the result is an `OK` variant of Result
       */
      isOk(): this is Ok<T, N, C>

      /**
       * Used to check if a `Result` is an `Err`
       *
       * @returns `true` if the result is an `Err` variant of Result
       */
      isErr(): this is Err<T, N, C>

      /**
       * Unwrap the `Ok` value, or return the default if there is an `Err`
       *
       * @param value the default value to return if there is an `Err`
       */
      else<A>(value: A): T | A

      /**
       * Returns the first `Ok`, if `Ok` doesnt exists returns the last error
       */
      or<A extends Std.Result<BlobType, BlobType, BlobType>>(value: A): Std.Result<T, N, C> | A

      unwrap(): T
    }

    // ------------- Generators -------------

    /**
     * Adds the ability to add additional causes to a function
     */
    type Middleware<A extends BlobType[], R> = ((...args: A) => R) & {
      addCauses: <C extends Std.ErrorValues[] = []>(
        ...additionalCauses: C
      ) => Middleware<
        A,
        R extends Std.Result<BlobType, BlobType, BlobType[]>
          ? Std.InjectError<R, Std.InferNameType<R>, C>
          : R extends Std.ResultAsync<BlobType, BlobType, BlobType[]>
            ? Std.InjectError<R, Std.InferNameType<R>, C>
            : R
      >
    }

    type $UnionsToResult<R, O, E> = O | E extends never
      ? never
      : R extends PromiseLike<BlobType>
        ? Std.ResultAsync<Std.InferOkType<O>, Std.InferNameType<E>, Std.InferCauseType<E>>
        : Std.Result<Std.InferOkType<O>, Std.InferNameType<E>, Std.InferCauseType<E>>

    /**
     * Converts a union of Results or other types to a single Result type.
     */
    type UnionsToResult<R> = Std.$UnionsToResult<
      R,
      | Extract<Awaited<R>, Ok<BlobType, BlobType, BlobType>>
      | Ok<Exclude<Awaited<R>, Std.Result<BlobType, BlobType, BlobType>>, never, []>,
      Extract<Awaited<R>, Err<BlobType, BlobType, BlobType>>
    >

    /**
     * Adds error tags to a Result or ResultAsync type.
     */
    type InjectError<
      U,
      N extends Std.ErrorValues,
      C extends Std.ErrorValues[],
    > = U extends Std.Result<infer O, infer Un, infer Uc>
      ? Std.Result<
          O,
          Un | N,
          Uc[number] | C[number] extends never ? [] : (Uc[number] | C[number])[]
        >
      : U extends Std.ResultAsync<infer O, infer Un, infer Uc>
        ? Std.ResultAsync<
            O,
            Un | N,
            Uc[number] | C[number] extends never ? [] : (Uc[number] | C[number])[]
          >
        : never

    type FromThrowable<A extends BlobType[], T, R> = (
      ...args: A
    ) => Std.UnionsToResult<
      T extends PromiseLike<BlobType>
        ? Std.ResultAsync<
            Awaited<T>,
            Std.InferNameType<Std.UnionsToResult<R>>,
            Std.InferCauseType<Std.UnionsToResult<R>>
          >
        : Std.Result<
            T,
            Std.InferNameType<Std.UnionsToResult<R>>,
            Std.InferCauseType<Std.UnionsToResult<R>>
          >
    >
  }
}
