import type { BlobType } from 'std:shared'

import type { InferFailure, InferSuccess, Result, ResultAsync, Success } from './result'

export namespace Helpers {
  export type UnionToResult<R> = R extends Result<BlobType, BlobType> ? R : Success<R>

  export type UnionToResultFor<P, R> = true extends P
    ? ResultAsync<InferSuccess<R>, InferFailure<R>>
    : Result<InferSuccess<R>, InferFailure<R>>
}
