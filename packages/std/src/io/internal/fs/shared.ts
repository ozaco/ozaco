import { IO_FLAGS, toPath } from 'std:io'
import { hasFlag } from 'std:shared'

import fs from 'node:fs/promises'
import { join } from 'node:path'

import type { Helpers } from '../../types/helpers'
import type { IODef } from '../../types/io'

import { fsCall } from './platform'
import { mapStat, walkRecursive } from './walk'

/** The `node:fs` open flag for a write under `IO_FLAGS.append` / `IO_FLAGS.exclusive`. */
export const writeFlagOf = (flags: number) => {
  if (hasFlag(flags, IO_FLAGS.append)) {
    return hasFlag(flags, IO_FLAGS.exclusive) ? 'ax' : 'a'
  }

  return hasFlag(flags, IO_FLAGS.exclusive) ? 'wx' : 'w'
}

/** The fs handlers that need nothing but `node:fs` — `BunIO` and `NodeIO` both spread them, so the
 * two impls cannot drift apart on these. */
export const sharedFs: Helpers.SharedFs = {
  *append(path, data) {
    yield* fsCall(fs.appendFile(toPath(path), data))
  },

  *rm(path, options) {
    yield* fsCall(fs.rm(toPath(path), options))
  },

  *stat(path) {
    return mapStat(yield* fsCall(fs.stat(toPath(path))))
  },

  *lstat(path) {
    return mapStat(yield* fsCall(fs.lstat(toPath(path))))
  },

  *readdir(path, options) {
    return yield* fsCall(fs.readdir(toPath(path), options))
  },

  *ensureDir(path) {
    yield* fsCall(fs.mkdir(toPath(path), { recursive: true }))
  },

  *emptyDir(path) {
    const p = toPath(path)
    yield* fsCall(fs.mkdir(p, { recursive: true }))
    const entries = yield* fsCall(fs.readdir(p))
    for (const entry of entries) {
      yield* fsCall(fs.rm(join(p, entry), { recursive: true, force: true }))
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
    yield* fsCall(fs.chmod(toPath(path), mode))
  },

  *symlink(target, path, type) {
    yield* fsCall(fs.symlink(toPath(target), toPath(path), type))
  },

  *readlink(path) {
    return yield* fsCall(fs.readlink(toPath(path)))
  },
}
