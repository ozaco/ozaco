import type { Future, Stream } from 'std:effect'

import type { IOStat, PathLike, ReadableLike, RmOptions, WalkEntry, WalkOptions } from './common'

// TODO: add custom error for action

export type IOActions = {
  fromReadable: (target: ReadableLike) => Stream<Uint8Array, void>
  readStream: (path: PathLike) => Stream<Uint8Array, void>
  writeStream: (path: PathLike, source: Stream<Uint8Array, unknown>) => Future<void, unknown>
  read: (path: PathLike) => Future<Uint8Array, unknown>
  readText: (path: PathLike, encoding?: string) => Future<string, unknown>
  write: (path: PathLike, data: Uint8Array | string) => Future<void, unknown>
  append: (path: PathLike, data: Uint8Array) => Future<void, unknown>
  copy: (src: PathLike, dest: PathLike) => Future<void, unknown>
  rename: (src: PathLike, dest: PathLike) => Future<void, unknown>
  rm: (path: PathLike, options?: RmOptions) => Future<void, unknown>
  exists: (path: PathLike) => Future<boolean, unknown>
  stat: (path: PathLike) => Future<IOStat, unknown>
  lstat: (path: PathLike) => Future<IOStat, unknown>
  readdir: (path: PathLike) => Future<string[], unknown>
  ensureDir: (path: PathLike) => Future<void, unknown>
  ensureFile: (path: PathLike) => Future<void, unknown>
  emptyDir: (path: PathLike) => Future<void, unknown>
  walk: (root: PathLike, options?: WalkOptions) => Future<WalkEntry[], unknown>
}
