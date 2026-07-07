import type { CodecDef } from 'std:codec'

import type { ConfigDef } from '../types'

/** The classification of a directory entry against the config naming grammar. */
export type FileKind = 'base' | { infix: string }

/** The dotted-or-plain base name, e.g. `.ozaco` (dot) or `ozaco`. */
export const baseName = (ctx: ConfigDef.Context): string => (ctx.dot ? `.${ctx.name}` : ctx.name)

/** The base config file name, e.g. `.ozaco.toml`. */
export const baseFile = (ctx: ConfigDef.Context): string => `${baseName(ctx)}.${ctx.ext}`

/** A variant/fragment file name for an infix, e.g. `.ozaco.local.toml`. */
export const infixFile = (ctx: ConfigDef.Context, infix: string): string =>
  `${baseName(ctx)}.${infix}.${ctx.ext}`

/** The config directory name, e.g. `.ozaco` (`DIR` feature). */
export const dirName = (ctx: ConfigDef.Context): string => baseName(ctx)

/**
 * Classify a file name: the exact `<base>.<ext>` is `'base'`; a `<base>.<infix>.<ext>` yields its
 * infix (variant or fragment); anything else is `undefined`.
 */
export const classify = (ctx: ConfigDef.Context, name: string): FileKind | undefined => {
  const base = baseName(ctx)
  const suffix = `.${ctx.ext}`

  if (name === `${base}${suffix}`) {
    return 'base'
  }

  if (name.startsWith(`${base}.`) && name.endsWith(suffix)) {
    const infix = name.slice(base.length + 1, name.length - suffix.length)
    if (infix.length > 0) {
      return { infix }
    }
  }

  return undefined
}

/** Derive a file extension from a codec name, e.g. `std/toml-codec` → `toml` (fallback `toml`). */
export const codecExt = (codec: CodecDef): string => {
  const match = /([a-z0-9]+)-codec/iu.exec(codec.name ?? '')
  return match?.[1] ?? 'toml'
}
