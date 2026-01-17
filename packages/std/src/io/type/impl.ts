import type { Result, ResultAsync } from 'std:result'
import type { BlobType } from 'std:shared'

import type { Api } from './api'

export namespace Impl {
  export interface Stats {
    stats: {
      (type: 'number'): ResultAsync<Api.Stats<number>, never>
      (type: 'bigint'): ResultAsync<Api.Stats<bigint>, never>
      (type?: 'number' | 'bigint'): ResultAsync<Api.Stats<bigint>, never>
    }

    statsSync: {
      (type: 'number'): Result<Api.Stats<number>, never>
      (type: 'bigint'): Result<Api.Stats<bigint>, never>
      (type?: 'number' | 'bigint'): Result<Api.Stats<bigint>, never>
    }
  }

  export type Handle = (
    path: string,
    options?: {
      root?: string | undefined
      data?: BlobType
    },
  ) => Result<Api.Handle, never>
}
