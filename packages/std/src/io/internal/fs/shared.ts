import { until } from 'std:effect'
import { IO_FLAGS, toPath } from 'std:io'
import { hasFlag } from 'std:shared'

import fs from 'node:fs/promises'
import { join } from 'node:path'

import type { IODef } from '../../types/io'

import { mapStat, walkRecursive } from './walk'

type SharedFs = Pick<
  IODef.Actions,
  | 'append'
  | 'rm'
  | 'stat'
  | 'lstat'
  | 'readdir'
  | 'ensureDir'
  | 'emptyDir'
  | 'walk'
  | 'chmod'
  | 'symlink'
  | 'readlink'
>

/** The `node:fs` open flag for a write under `IO_FLAGS.append` / `IO_FLAGS.exclusive`. */
export const writeFlagOf = (flags: number) => {
  if (hasFlag(flags, IO_FLAGS.append)) {
    return hasFlag(flags, IO_FLAGS.exclusive) ? 'ax' : 'a'
  }

  return hasFlag(flags, IO_FLAGS.exclusive) ? 'wx' : 'w'
}

/** The fs handlers that need nothing but `node:fs` — `BunIO` and `NodeIO` both spread them, so the
 * two impls cannot drift apart on these. */
export const sharedFs: SharedFs = {
  *append(path, data) {
    yield* until(fs.appendFile(toPath(path), data))
  },

  *rm(path, options) {
    yield* until(fs.rm(toPath(path), options))
  },

  *stat(path) {
    return mapStat(yield* until(fs.stat(toPath(path))))
  },

  *lstat(path) {
    return mapStat(yield* until(fs.lstat(toPath(path))))
  },

  *readdir(path, options) {
    return yield* until(fs.readdir(toPath(path), options))
  },

  *ensureDir(path) {
    yield* until(fs.mkdir(toPath(path), { recursive: true }))
  },

  *emptyDir(path) {
    const p = toPath(path)
    yield* until(fs.mkdir(p, { recursive: true }))
    const entries = yield* until(fs.readdir(p))
    for (const entry of entries) {
      yield* until(fs.rm(join(p, entry), { recursive: true, force: true }))
    }
  },

  *walk(root, options) {
    const results: IODef.WalkEntry[] = []
    yield* walkRecursive(
      toPath(root),
      {
        flags: options?.flags ?? IO_FLAGS.files | IO_FLAGS.dirs,
        maxDepth: options?.maxDepth ?? Number.POSITIVE_INFINITY,
        match: options?.match,
        skip: options?.skip,
      },
      0,
      results,
    )
    return results
  },

  *chmod(path, mode) {
    yield* until(fs.chmod(toPath(path), mode))
  },

  *symlink(target, path, type) {
    yield* until(fs.symlink(toPath(target), toPath(path), type))
  },

  *readlink(path) {
    return yield* until(fs.readlink(toPath(path)))
  },
}
