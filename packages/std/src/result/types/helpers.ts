import type { BlobType } from 'std:shared'

import type { Result, ResultAsync, ResultFor, ResultMaybeAsync } from './result'

export namespace Helpers {
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

  export type UnionToResult<R> = R extends Result<BlobType, BlobType> ? R : ResultFor<false, R, never>

  export type UnionToResultFor<P, R> = true extends P
    ? ResultAsync<InferSuccess<R>, InferFailure<R>>
    : Result<InferSuccess<R>, InferFailure<R>>
}
