import type { Result, ResultAsync } from 'std:result'
import type { BlobType } from 'std:shared'

import type { PathType } from '../const'
import type { Api } from './api'

export namespace Impl {
  export interface StatsAsync<E = never> {
    (handler: Api.Handle, type: 'number'): ResultAsync<Api.Stats<number>, E>
    (handler: Api.Handle, type: 'bigint'): ResultAsync<Api.Stats<bigint>, E>
    (handler: Api.Handle): ResultAsync<Api.Stats<bigint>, E>
  }

  export interface StatsSync<E = never> {
    (handler: Api.Handle, type: 'number'): Result<Api.Stats<number>, E>
    (handler: Api.Handle, type: 'bigint'): Result<Api.Stats<bigint>, E>
    (handler: Api.Handle): Result<Api.Stats<bigint>, E>
  }

  export interface Stats<E = never> {
    stats: Impl.StatsAsync<E>
    statsSync: Impl.StatsSync<E>
  }

  export type Handle<E = never> = (
    path: string,
    options?: {
      root?: string | undefined
      data?: BlobType
    },
  ) => Result<Api.Handle, E>

  export interface Path {
    join: (...segments: string[]) => string
    resolve: (...segments: string[]) => string
    basename: (path: string, suffix?: string) => string
    dirname: (path: string) => string
    extname: (path: string) => string | null
    type: (path: string) => PathType
    relative: (from: string, to: string) => string
    cwd: () => string
  }
}
