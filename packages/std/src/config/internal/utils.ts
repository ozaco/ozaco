import type { CodecDef } from 'std:codec'
import { operation } from 'std:effect'
import { IO } from 'std:io'
import { deepMerge, getPath, hasFlag } from 'std:shared'

import { EXTENDS_KEY, Features } from '../const'
import type { ConfigDef } from '../types'

import { collectDirs } from './discover'

/** Coerce an env string into a boolean/number when it looks like one, else keep the string. */
export const coerce = (value: string): unknown => {
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  if (value !== '' && !Number.isNaN(Number(value))) {
    return Number(value)
  }
  return value
}

/** A source's effective data: its `extends` (lower) merged under its own data (higher). */
export const resolve = (source: ConfigDef.Source): ConfigDef.Object =>
  deepMerge(...source.extends.map(resolve), source.data)

/**
 * The full source list to merge: the discovered chain, plus the working target when it is not already
 * a chain member (a base file that is not on disk yet). It is appended last — the lowest precedence —
 * which is safe because a standalone working only ever holds brand-new keys.
 */
export const sources = (ctx: ConfigDef.Context): ConfigDef.Source[] =>
  ctx.chain.includes(ctx.working) ? ctx.chain : [...ctx.chain, ctx.working]

/**
 * Merge the discovered chain into a single object. The chain is stored innermost → outermost (index 0
 * wins), so it is folded in reverse (outermost = lowest precedence first); the `env` overlay is
 * applied last as the highest-precedence source.
 */
export const merge = (ctx: ConfigDef.Context): ConfigDef.Object =>
  deepMerge(...sources(ctx).toReversed().map(resolve), ctx.env)

/** The dotted-or-plain base name, e.g. `.ozaco` (dot) or `ozaco`. */
export const baseName = (ctx: ConfigDef.Context): string => (ctx.dot ? `.${ctx.name}` : ctx.name)

/** The base config file name, e.g. `.ozaco.toml`. */
export const baseFile = (ctx: ConfigDef.Context): string => `${baseName(ctx)}.${ctx.ext}`

/** The variant file name for an infix, e.g. `.prod.ozaco.toml` (the infix leads the name). */
export const infixFile = (ctx: ConfigDef.Context, infix: string): string =>
  `${ctx.dot ? '.' : ''}${infix}.${ctx.name}.${ctx.ext}`

/** The config directory name, e.g. `.ozaco` (`DIR` feature). */
export const dirName = (ctx: ConfigDef.Context): string => baseName(ctx)

/** Derive a file extension from a codec name, e.g. `std/toml-codec` → `toml` (fallback `toml`). */
export const codecExt = (codec: CodecDef): string => {
  const match = /([a-z0-9]+)-codec/iu.exec(codec.name ?? '')
  return match?.[1] ?? 'toml'
}

export const constCtx = (ctx: ConfigDef.Context) =>
  operation(function* () {
    return ctx
  })

/** Every source, own + `extends`, highest precedence first (own data wins, later extends win). */
export const collectSources = (list: ConfigDef.Source[]): ConfigDef.Source[] =>
  list.flatMap(source => [source, ...collectSources(source.extends.toReversed())])

/**
 * The source file `key` should be written to: the highest-precedence file that already defines the
 * key or its nearest existing ancestor path — so `set('a.b.c')` lands in the file that owns `a.b`, or
 * failing that `a`. `undefined` when no file mentions any ancestor (the caller falls back to the base
 * working file, where genuinely new top-level keys belong).
 */
export const findOrigin = (list: ConfigDef.Source[], key: string): ConfigDef.Source | undefined => {
  const flat = collectSources(list)
  const parts = key.split('.')

  for (let depth = parts.length; depth >= 1; depth--) {
    const prefix = parts.slice(0, depth).join('.')
    for (const source of flat) {
      if (getPath(source.data, prefix) !== undefined) {
        return source
      }
    }
  }
  return undefined
}

/**
 * Every file that defines `key`, highest → lowest precedence, with the value each holds there. The
 * env overlay (if it defines `key`) leads as `'<env>'`; then each chain source (own + `extends`).
 */
export const explainOf = (ctx: ConfigDef.Context, key: string): ConfigDef.Origin[] => {
  const out: ConfigDef.Origin[] = []

  const envValue = getPath(ctx.env, key)
  if (envValue !== undefined) {
    out.push({ path: '<env>', value: envValue })
  }

  for (const source of collectSources(sources(ctx))) {
    const value = getPath(source.data, key)
    if (value !== undefined) {
      out.push({ path: source.path, value })
    }
  }

  return out
}

/** The object to persist for a source — its data plus the `extends` spec, so inheritance survives. */
export const payloadOf = (source: ConfigDef.Source): ConfigDef.Object =>
  source.extendsSpec === undefined
    ? source.data
    : { [EXTENDS_KEY]: source.extendsSpec, ...source.data }

/**
 * The directories/files `watch` should observe: each existing config directory (`DIR`) watched
 * recursively, plus every discovered source file NOT already covered by one of those directories.
 */
export const watchTargets = operation(function* (ctx: ConfigDef.Context) {
  const recursiveDirs: string[] = []
  if (hasFlag(ctx.features, Features.DIR)) {
    for (const level of yield* collectDirs(ctx, ctx.cwd)) {
      const configDir = yield* IO.actions.join(level, dirName(ctx))
      if (yield* IO.actions.exists(configDir)) {
        recursiveDirs.push(configDir)
      }
    }
  }

  const files = new Set<string>()
  for (const source of collectSources(ctx.chain)) {
    if (!recursiveDirs.some(dir => source.path.startsWith(`${dir}/`))) {
      files.add(source.path)
    }
  }

  return { recursiveDirs, files: [...files] }
})
