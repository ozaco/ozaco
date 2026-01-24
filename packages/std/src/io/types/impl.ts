import type { Result, ResultAsync } from 'std:result'

import type { Flags, PathType } from '../const'
import type { Api } from './api'

export namespace Impl {
  export interface StatsAsync<E = never> {
    (handle: Api.Handle, type: 'number'): ResultAsync<Api.Stats<number>, E>
    (handle: Api.Handle, type: 'bigint'): ResultAsync<Api.Stats<bigint>, E>
    (handle: Api.Handle): ResultAsync<Api.Stats<bigint>, E>
  }

  export interface StatsSync<E = never> {
    (handle: Api.Handle, type: 'number'): Result<Api.Stats<number>, E>
    (handle: Api.Handle, type: 'bigint'): Result<Api.Stats<bigint>, E>
    (handle: Api.Handle): Result<Api.Stats<bigint>, E>
  }

  export interface Stats<E = never> {
    stats: Impl.StatsAsync<E>
    statsSync: Impl.StatsSync<E>
  }

  export type Handle = (path: string, root?: string | undefined) => Api.Handle

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

  export type Open<E = never> = (handle: Api.Handle | string, flag?: Flags) => ResultAsync<Api.File, E>
}
