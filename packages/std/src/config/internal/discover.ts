import { operation } from 'std:effect'
import { IO } from 'std:io'
import { hasFlag } from 'std:shared'

import { Features } from '../const'
import type { ConfigDef } from '../types'

import { readSource } from './read'
import { baseFile, dirName, infixFile } from './utils'

/**
 * Scan one directory for its sources, highest → lowest precedence: active variant → config-dir files
 * (later name wins) → base file. Each layer is toggled by its feature. Only files that exist on disk
 * are returned — the (possibly absent) working file is pinned later, never invented here.
 */
const scanDir = operation(function* (ctx: ConfigDef.Context, dir: string, seen: Set<string>) {
  const out: ConfigDef.Source[] = []

  if (!(yield* IO.actions.exists(dir))) {
    return out
  }

  const names = yield* IO.actions.readdir(dir)

  // 1) active-variant overlay (highest)
  if (hasFlag(ctx.features, Features.VARIANT) && ctx.variant) {
    const name = infixFile(ctx, ctx.variant)
    if (names.includes(name)) {
      const source = yield* readSource(ctx, yield* IO.actions.join(dir, name), seen)
      if (source) {
        out.push(source)
      }
    }
  }

  // 2) config-directory files — read recursively (`<name>/**/*.<ext>`) so nested files merge too,
  // matching the recursive watch; later name wins.
  if (hasFlag(ctx.features, Features.DIR)) {
    const configDir = yield* IO.actions.join(dir, dirName(ctx))
    if (yield* IO.actions.exists(configDir)) {
      const suffix = `.${ctx.ext}`
      const files = (yield* IO.actions.readdir(configDir, { recursive: true }))
        .filter(name => name.endsWith(suffix))
        .toSorted()
        .toReversed()

      for (const name of files) {
        const source = yield* readSource(ctx, yield* IO.actions.join(configDir, name), seen)
        if (source) {
          out.push(source)
        }
      }
    }
  }

  // 3) base file (lowest)
  if (hasFlag(ctx.features, Features.FILE)) {
    const name = baseFile(ctx)
    if (names.includes(name)) {
      const source = yield* readSource(ctx, yield* IO.actions.join(dir, name), seen)
      if (source) {
        out.push(source)
      }
    }
  }

  return out
})

/** The directories to scan, innermost → outermost: `start`, then its parents up to `home` (`CHAIN`). */
export const collectDirs = operation(function* (ctx: ConfigDef.Context, start: string) {
  const dirs: string[] = [start]
  if (!hasFlag(ctx.features, Features.CHAIN)) {
    return dirs
  }

  let dir = start
  while (dir !== ctx.home) {
    const parent = yield* IO.actions.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
    dirs.push(dir)
  }

  return dirs
})

/**
 * Discover the chain from `start` (innermost → outermost, highest precedence first) and pin the
 * working file — the cwd base file. When it exists on disk it is a live chain member, so `set`/`clear`
 * edits reflect in `merged`. When it does not, a standalone target is returned that is NOT part of the
 * chain, so it never appears in `tree` until it is actually written.
 */
export const discover = operation(function* (ctx: ConfigDef.Context, start: string) {
  const dirs = yield* collectDirs(ctx, start)
  const seen = new Set<string>()
  const chain: ConfigDef.Source[] = []

  for (const dir of dirs) {
    chain.push(...(yield* scanDir(ctx, dir, seen)))
  }

  const workingPath = yield* IO.actions.join(start, baseFile(ctx))
  const working = chain.find(source => source.path === workingPath) ?? {
    path: workingPath,
    data: {},
    extends: [],
  }

  return { chain, working }
})
