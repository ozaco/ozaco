import { operation } from 'std:effect'
import { IO } from 'std:io'
import { hasFlag } from 'std:shared'

import { Features } from '../const'
import type { ConfigDef } from '../types'

import { baseFile, classify, dirName, infixFile } from './paths'
import { readSource } from './read'

/** The directories to scan, innermost → outermost: `start`, then its parents up to `home` (`CHAIN`). */
const collectDirs = operation(function* (ctx: ConfigDef.Context, start: string) {
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
 * Scan one directory for its sources, highest → lowest precedence:
 * variant → fragments (later name wins) → config-dir files → base file. Each toggled by its feature.
 * `ensureBase` appends an empty base source when the cwd file is missing so edits have a home.
 */
const scanDir = operation(function* (
  ctx: ConfigDef.Context,
  dir: string,
  options: { seen: Set<string>; ensureBase: boolean },
) {
  const { seen, ensureBase } = options
  const out: ConfigDef.Source[] = []

  if (!(yield* IO.actions.exists(dir))) {
    return out
  }

  const names = yield* IO.actions.readdir(dir)
  const variantActive = hasFlag(ctx.features, Features.VARIANT) && Boolean(ctx.variant)

  // 1) variant overlay (highest)
  if (variantActive) {
    const name = infixFile(ctx, ctx.variant!)
    if (names.includes(name)) {
      const source = yield* readSource(ctx, yield* IO.actions.join(dir, name), seen)
      if (source) {
        out.push(source)
      }
    }
  }

  // 2) fragments — every other infix file, later name wins (so push highest-first)
  if (hasFlag(ctx.features, Features.FRAGMENT)) {
    const fragments = names
      .filter(name => {
        const kind = classify(ctx, name)
        if (kind === undefined || kind === 'base') {
          return false
        }
        return !(variantActive && kind.infix === ctx.variant)
      })
      .toSorted()
      .toReversed()

    for (const name of fragments) {
      const source = yield* readSource(ctx, yield* IO.actions.join(dir, name), seen)
      if (source) {
        out.push(source)
      }
    }
  }

  // 3) config directory files
  if (hasFlag(ctx.features, Features.DIR)) {
    const configDir = yield* IO.actions.join(dir, dirName(ctx))
    if (yield* IO.actions.exists(configDir)) {
      const suffix = `.${ctx.ext}`
      const files = (yield* IO.actions.readdir(configDir))
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

  // 4) base file (lowest)
  if (hasFlag(ctx.features, Features.FILE)) {
    const name = baseFile(ctx)
    if (names.includes(name)) {
      const source = yield* readSource(ctx, yield* IO.actions.join(dir, name), seen)
      if (source) {
        out.push(source)
      }
    } else if (ensureBase) {
      out.push({ path: yield* IO.actions.join(dir, name), data: {}, extends: [] })
    }
  }

  return out
})

/**
 * Discover the full chain from `start` and identify the working file (the cwd base file). The
 * working source is a live member of the chain, so `set`/`remove`/`clear` edits reflect in `merged`.
 */
export const discover = operation(function* (ctx: ConfigDef.Context, start: string) {
  const dirs = yield* collectDirs(ctx, start)
  const seen = new Set<string>()
  const chain: ConfigDef.Source[] = []

  for (const [index, dir] of dirs.entries()) {
    chain.push(...(yield* scanDir(ctx, dir, { seen, ensureBase: index === 0 })))
  }

  const workingPath = yield* IO.actions.join(start, baseFile(ctx))
  let working = chain.find(source => source.path === workingPath)
  if (!working) {
    working = { path: workingPath, data: {}, extends: [] }
    chain.push(working)
  }

  return { chain, working }
})
