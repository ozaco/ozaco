import type { Future } from 'std:effect'

import type { IOErrorTag, IOStat, PathLike, RmOptions, WalkEntry, WalkOptions } from './common'

export type IOActions = {
  read: (path: PathLike) => Future<Uint8Array, IOErrorTag>
  readText: (path: PathLike, encoding?: string) => Future<string, IOErrorTag>
  write: (path: PathLike, data: Uint8Array) => Future<void, IOErrorTag>
  writeText: (path: PathLike, content: string) => Future<void, IOErrorTag>
  append: (path: PathLike, data: Uint8Array) => Future<void, IOErrorTag>
  appendText: (path: PathLike, content: string) => Future<void, IOErrorTag>
  copy: (src: PathLike, dest: PathLike) => Future<void, IOErrorTag>
  rename: (src: PathLike, dest: PathLike) => Future<void, IOErrorTag>
  rm: (path: PathLike, options?: RmOptions) => Future<void, IOErrorTag>
  exists: (path: PathLike) => Future<boolean, IOErrorTag>
  stat: (path: PathLike) => Future<IOStat, IOErrorTag>
  lstat: (path: PathLike) => Future<IOStat, IOErrorTag>
  readdir: (path: PathLike) => Future<string[], IOErrorTag>
  ensureDir: (path: PathLike) => Future<void, IOErrorTag>
  ensureFile: (path: PathLike) => Future<void, IOErrorTag>
  emptyDir: (path: PathLike) => Future<void, IOErrorTag>
  walk: (root: PathLike, options?: WalkOptions) => Future<WalkEntry[], IOErrorTag>
}
