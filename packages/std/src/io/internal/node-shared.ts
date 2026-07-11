import { until } from 'std:effect'
import type { IOStat, WalkEntry, WalkOptions } from 'std:io'
import { IO_FLAGS } from 'std:io'
import { hasFlag } from 'std:shared'
import type { AnyType } from 'std:shared'

import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import { join } from 'node:path'

export const mapStat = (s: Stats): IOStat => ({
  isFile: s.isFile(),
  isDirectory: s.isDirectory(),
  isSymlink: s.isSymbolicLink(),
  size: s.size,
  mtime: s.mtime,
  atime: s.atime,
  birthtime: s.birthtime,
})

// oxlint-disable-next-line max-params
export function* walkRecursive(
  root: string,
  options: Required<Pick<WalkOptions, 'flags' | 'maxDepth'>> & Pick<WalkOptions, 'match' | 'skip'>,
  depth: number,
  results: WalkEntry[],
): Generator<AnyType, void, AnyType> {
  const flags = options.flags ?? 0

  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return
  }

  let entries: string[]
  try {
    entries = yield* until(fs.readdir(root))
  } catch {
    return
  }

  for (const name of entries) {
    const fullPath = join(root, name)

    let s: Stats
    try {
      s = hasFlag(flags, IO_FLAGS.FOLLOW_SYMLINKS)
        ? yield* until(fs.stat(fullPath))
        : yield* until(fs.lstat(fullPath))
    } catch {
      continue
    }

    const entry: WalkEntry = {
      path: fullPath,
      name,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymlink: s.isSymbolicLink(),
    }

    if (options.skip?.some(re => re.test(fullPath))) {
      continue
    }

    const matchesPattern = !options.match?.length || options.match.some(re => re.test(fullPath))

    if (entry.isFile && hasFlag(flags, IO_FLAGS.FILES) && matchesPattern) {
      results.push(entry)
    }
    if (entry.isDirectory) {
      if (hasFlag(flags, IO_FLAGS.DIRS) && matchesPattern) {
        results.push(entry)
      }
      yield* walkRecursive(fullPath, options, depth + 1, results)
    }
  }
}
