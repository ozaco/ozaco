import type { Future, Stream } from 'std:effect'

import type {
  HashAlgorithm,
  IOStat,
  PathLike,
  ReadableLike,
  WalkEntry,
  WalkOptions,
} from './common'

// TODO: add custom error for action

export type IOActions = {
  randomBytes: (length: number) => Future<Uint8Array, unknown>
  hmac: (algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array) => Future<Uint8Array, unknown>
  hash: (algorithm: HashAlgorithm, data: Uint8Array) => Future<Uint8Array, unknown>

  fromReadable: (target: ReadableLike) => Stream<Uint8Array, void>
  readStream: (path: PathLike) => Stream<Uint8Array, void>
  writeStream: (
    path: PathLike,
    source: Stream<Uint8Array, unknown>,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  read: (path: PathLike) => Future<Uint8Array, unknown>
  readText: (path: PathLike, encoding?: string) => Future<string, unknown>
  write: (
    path: PathLike,
    data: Uint8Array | string,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  append: (path: PathLike, data: Uint8Array) => Future<void, unknown>
  copy: (
    src: PathLike,
    dest: PathLike,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  rename: (
    src: PathLike,
    dest: PathLike,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  rm: (
    path: PathLike,
    options?: {
      recursive?: boolean
      force?: boolean
    },
  ) => Future<void, unknown>
  exists: (path: PathLike) => Future<boolean, unknown>
  stat: (path: PathLike) => Future<IOStat, unknown>
  lstat: (path: PathLike) => Future<IOStat, unknown>
  readdir: (
    path: PathLike,
    options?: {
      recursive?: boolean
    },
  ) => Future<string[], unknown>
  ensureDir: (path: PathLike) => Future<void, unknown>
  ensureFile: (path: PathLike) => Future<void, unknown>
  emptyDir: (path: PathLike) => Future<void, unknown>
  walk: (root: PathLike, options?: WalkOptions) => Future<WalkEntry[], unknown>
}
