import type { Result, ResultAsync } from 'std:result'

import type { Flags, PathType } from '../const'
import type { Api } from './api'

export namespace Impl {
  export type Handle = (path: string | URL | Api.Handle, root?: string | undefined) => Api.Handle

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

  export interface StatsAsync<E = never> {
    (target: Api.Target, type: 'number'): ResultAsync<Api.Stats<number>, E>
    (target: Api.Target, type: 'bigint'): ResultAsync<Api.Stats<bigint>, E>
    (target: Api.Target): ResultAsync<Api.Stats<bigint>, E>
  }

  export interface StatsSync<E = never> {
    (target: Api.Target, type: 'number'): Result<Api.Stats<number>, E>
    (target: Api.Target, type: 'bigint'): Result<Api.Stats<bigint>, E>
    (target: Api.Target): Result<Api.Stats<bigint>, E>
  }

  export interface Stats<E = never> {
    stats: Impl.StatsAsync<E>
    statsSync: Impl.StatsSync<E>
  }

  export type Exists<E = never> = (target: Api.Target) => ResultAsync<boolean, E>

  export type Open<E = never> = (target: Api.Target, flag?: Flags) => ResultAsync<Api.File, E>

  export type Read<E = never> = (
    file: Api.File,
    buffer: ArrayBufferLike,
    options?: {
      offset?: number | undefined
      length?: number | undefined
      position?: number | bigint | null | undefined
    },
  ) => ResultAsync<number, E>

  export type Write<E = never> = (
    file: Api.File,
    buffer: ArrayBufferLike,
    options?: {
      offset?: number | undefined
      length?: number | undefined
      position?: number | null | undefined
    },
  ) => ResultAsync<number, E>
}
