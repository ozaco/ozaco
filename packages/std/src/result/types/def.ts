import type { AnyType, Helpers, IsPromiseStrict } from 'std:shared'

import type { Maybe } from './maybe'
import type { Result } from './result'

/** The function shapes of the result module — what `succeed`, `fail`, `auto`, `throwable`,
 * `appendCauses`, `unwrap`, `just`, `nothing` and `asFailure` are typed as — and the shapes the
 * chain rendering of `formatFailure` lays out (`Level`, `Block`). */
export namespace ResultDef {
  /** What `fail` / `appendCauses` take as a cause: a string stays, a Failure (a failed Result) is
   * nested as the SAME object, a Success / `null` / `undefined` is dropped. */
  export type CauseInput = string | Result<unknown, unknown> | null | undefined

  export interface Succeed {
    (): Result.Success<void>

    <T extends `${string}`>(value: T): Result.Success<T>
    <const T>(value: T): Result.Success<T>
  }

  export interface Fail {
    (): Result.Failure<never>

    <E extends `${string}`>(error: E): Result.Failure<E>
    <const E>(error: E, message?: string, ...causes: CauseInput[]): Result.Failure<E>
  }

  export interface Auto {
    <R extends Result<AnyType, AnyType>>(
      result: R,
    ): Result<Result.InferSuccess<R>, Result.InferFailure<R>>
    /** a failing `result` yields `defaultValue` — itself a Result when one is given (a Failure
     * default flows out as that Failure), else wrapped as a Success. */
    <R extends Result<AnyType, AnyType>, T>(
      result: R,
      defaultValue: T,
    ): Result.FromUnion<Result.InferSuccess<R> | T>

    <T extends `${string}`>(value: T): Result<T, never>
    <const T>(value: T): Result.FromUnion<T>
  }

  /** `cb`'s value as a Result; a throw (a rejection) folded by `asFailure` — through `tags`'
   * matchers when a bundle is given — with `causes` appended. */
  export interface Throwable {
    <T>(
      cb: () => Promise<T>,
      tags: Helpers.TagMatchers,
      ...causes: string[]
    ): Promise<Result.FromUnion<T | Result.Failure<unknown>>>
    <T>(
      cb: () => Promise<T>,
      ...causes: string[]
    ): Promise<Result.FromUnion<T | Result.Failure<unknown>>>

    <R>(
      cb: () => R,
      tags: Helpers.TagMatchers,
      ...causes: string[]
    ): Result.FromUnion<R | Result.Failure<unknown>>
    <R>(cb: () => R, ...causes: string[]): Result.FromUnion<R | Result.Failure<unknown>>
  }

  /** Append `causes` (normalized as `fail` does) to a Failure IN PLACE — the same object comes
   * back; a Success passes through untouched. */
  export type AppendCauses = <T extends Result<AnyType, AnyType>>(
    result: T,
    ...causes: CauseInput[]
  ) => T

  export interface Unwrap {
    <R extends Result<never, AnyType>>(result: R): never

    <R extends Result<AnyType, AnyType> | PromiseLike<Result<AnyType, AnyType>>>(
      result: R,
    ): true extends IsPromiseStrict<R>
      ? Promise<Result.InferSuccess<Awaited<R>>>
      : Result.InferSuccess<Awaited<R>>
    <R extends Result<AnyType, AnyType> | PromiseLike<Result<AnyType, AnyType>>, T>(
      result: R,
      defaultValue: T,
    ): true extends IsPromiseStrict<R>
      ? Promise<Result.InferSuccess<Awaited<R>> | T>
      : Result.InferSuccess<Awaited<R>> | T
  }

  export interface Just {
    (): Maybe<void>
    <T>(value: T): Maybe<T>
    <T>(value?: T | undefined): Maybe<T | undefined>
  }

  export type Nothing = <T = void>() => Maybe<T>

  /**
   * A Failure as is; any other value folded, the value kept as `raw`: into the first tag of
   * `tags` whose matcher recognizes it (the message a function matcher named, else the value's
   * own `message`, else `code`), else into `ResultErrors.Unknown` (`std:result.unknown`, its
   * `serializeError` text the message). A `std:result.unknown` fold given with `tags` is
   * re-classified the same way. `causes` are appended (normalized as `fail` does).
   */
  export interface AsFailure {
    <E, M extends Helpers.TagMatchers>(
      error: Result.Failure<E>,
      tags: M,
      ...causes: CauseInput[]
    ): Result.Failure<E | Helpers.MatchedTag<M>>
    (error: unknown, tags: Helpers.TagMatchers, ...causes: CauseInput[]): Result.Failure<unknown>
    <E>(error: Result.Failure<E>, ...causes: CauseInput[]): Result.Failure<E>
    (error: unknown, ...causes: CauseInput[]): Result.Failure<unknown>
  }

  export interface FormatOptions {
    /** Render the whole cause chain, Java style, over several lines. */
    chain?: boolean
    /** The UTF-8 byte budget of the chain rendering (default 16384); every level's header line is
     * kept (type / message cut to 200 bytes under a budget), the `at` lines fill what is left,
     * innermost level first. */
    maxBytes?: number
  }

  /** One failure of a chain as the rendering reads it. */
  export interface Level {
    /** The tag (a non-string `error` as its `serializeError` text). */
    readonly type: string
    readonly message: string
    /** Its domain (string) causes, in stored order. */
    readonly causes: readonly string[]
  }

  /** A level laid out: its header line and its `at` lines. */
  export interface Block {
    header: string
    lines: string[]
  }
}
