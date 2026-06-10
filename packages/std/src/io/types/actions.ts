import type { Future, Stream } from 'std:effect'

import type {
  HashAlgorithm,
  IOStat,
  PathLike,
  ReadableLike,
  StreamClose,
  WalkEntry,
  WalkOptions,
} from './common'

export type IOActions = {
  env: <R extends Record<string, unknown>, K extends keyof R = never>(
    mapper: (data: Record<string, string | undefined>) => R,
    optional?: readonly K[],
  ) => Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }, unknown>

  randomBytes: (length: number) => Future<Uint8Array, unknown>
  hmac: (algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array) => Future<Uint8Array, unknown>
  hash: (algorithm: HashAlgorithm, data: Uint8Array) => Future<Uint8Array, unknown>

  fromReadable: (target: ReadableLike) => Stream<Uint8Array, StreamClose>
  readStream: (path: PathLike) => Stream<Uint8Array, StreamClose>
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
