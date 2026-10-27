import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { IO_FLAGS, toPath } from 'std:io'
import { asFailure, fail, isFailure } from 'std:result'
import { hasFlag, toHex } from 'std:shared'

import { realpath as realpathCallback } from 'node:fs'
import fs from 'node:fs/promises'
import { join } from 'node:path'

import { IOErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'
import type { IODef } from '../../types/io'

import { fsCall } from './platform'
import { mapStat, walkRecursive } from './walk'

/** `fs.realpath.native` (the promises API has no native variant) — the resolver that returns a
 * long name for a Windows 8.3 one. */
const nativeRealpath = (path: string) =>
  new Promise<string>((resolve, reject) => {
    realpathCallback.native(path, (error, resolved) => {
      if (error) {
        reject(error)
      } else {
        resolve(resolved)
      }
    })
  })

function* pathExists(path: string): Operation<boolean> {
  try {
    yield* fsCall(fs.access(path))

    return true
  } catch {
    return false
  }
}

/** The atomic branch of {@link writeFile}: the data goes to `<path>.<random>.tmp` beside the
 * target (created exclusively with `mode`, fsynced), then is renamed over it; whatever fails
 * removes the temporary file and raises the original failure. */
function* writeAtomic(path: string, data: Uint8Array | string, options: IODef.WriteOptions) {
  const flags = options.flags ?? IO_FLAGS.none

  if (hasFlag(flags, IO_FLAGS.append)) {
    return yield* fail(IOErrors.Unsupported, 'an atomic write cannot append (IO_FLAGS.append)')
  }

  if (hasFlag(flags, IO_FLAGS.exclusive) && (yield* pathExists(path))) {
    return yield* fail(IOErrors.Exists, `destination already exists: ${path}`)
  }

  const arriving = `${path}.${toHex(crypto.getRandomValues(new Uint8Array(6)))}.tmp`

  try {
    const handle = yield* fsCall(fs.open(arriving, 'wx', options.mode))

    try {
      yield* fsCall(handle.writeFile(data))
      yield* fsCall(handle.sync())
    } finally {
      yield* fsCall(handle.close())
    }

    if (options.mode !== undefined) {
      yield* fsCall(fs.chmod(arriving, options.mode))
    }

    yield* fsCall(fs.rename(arriving, path))
  } catch (error) {
    yield* fsCall(fs.rm(arriving, { force: true }))

    return yield* asFailure(error, IOErrors)
  }
}

/** The `node:fs` open flag for a write under `IO_FLAGS.append` / `IO_FLAGS.exclusive`. */
export const writeFlagOf = (flags: number) => {
  if (hasFlag(flags, IO_FLAGS.append)) {
    return hasFlag(flags, IO_FLAGS.exclusive) ? 'ax' : 'a'
  }

  return hasFlag(flags, IO_FLAGS.exclusive) ? 'wx' : 'w'
}

/** The `node:fs` write both impls share: `flags` as the open flag, `mode` passed to the create
 * and then applied with `chmod` (an existing file is changed too, the umask does not apply),
 * `atomic` through {@link writeAtomic}. */
export function* writeFile(
  path: string,
  data: Uint8Array | string,
  options?: IODef.WriteOptions,
): Operation<void> {
  if (options?.atomic) {
    return yield* writeAtomic(path, data, options)
  }

  const flag = writeFlagOf(options?.flags ?? IO_FLAGS.none)

  yield* fsCall(fs.writeFile(path, data, { flag, mode: options?.mode }))

  if (options?.mode !== undefined) {
    yield* fsCall(fs.chmod(path, options.mode))
  }
}

/** The fs handlers that need nothing but `node:fs` — `BunIO` and `NodeIO` both spread them, so the
 * two impls cannot drift apart on these. */
export const sharedFs: Helpers.SharedFs = {
  *append(path, data) {
    yield* fsCall(fs.appendFile(toPath(path), data))
  },

  *rm(path, options) {
    if (options?.empty) {
      const outcome = yield* attempt(() => fsCall(fs.rmdir(toPath(path))))

      if (isFailure(outcome) && !(options.force && outcome.error === IOErrors.NotFound)) {
        return yield* outcome
      }

      return
    }

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

  *ensureDir(path, options) {
    const p = toPath(path)

    yield* fsCall(fs.mkdir(p, { recursive: true, mode: options?.mode }))

    if (options?.mode !== undefined) {
      yield* fsCall(fs.chmod(p, options.mode))
    }
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

  *realpath(path) {
    return yield* fsCall(nativeRealpath(toPath(path)))
  },
}
