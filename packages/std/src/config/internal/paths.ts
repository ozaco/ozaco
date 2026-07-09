import type { CodecDef } from 'std:codec'

import type { ConfigDef } from '../types'

/** The classification of a directory entry against the config naming grammar. */
export type FileKind = 'base' | { infix: string }

/** The dotted-or-plain base name, e.g. `.ozaco` (dot) or `ozaco`. */
export const baseName = (ctx: ConfigDef.Context): string => (ctx.dot ? `.${ctx.name}` : ctx.name)

/** The base config file name, e.g. `.ozaco.toml`. */
export const baseFile = (ctx: ConfigDef.Context): string => `${baseName(ctx)}.${ctx.ext}`

/** A variant/fragment file name for an infix, e.g. `.local.ozaco.toml` (the infix leads the name). */
export const infixFile = (ctx: ConfigDef.Context, infix: string): string =>
  `${ctx.dot ? '.' : ''}${infix}.${ctx.name}.${ctx.ext}`

/** The config directory name, e.g. `.ozaco` (`DIR` feature). */
export const dirName = (ctx: ConfigDef.Context): string => baseName(ctx)

/**
 * Classify a file name: the exact `<name>.<ext>` is `'base'`; a `<infix>.<name>.<ext>` yields its
 * infix (variant or fragment); anything else is `undefined`. In `dot` mode every config file is
 * hidden behind a leading dot (`.<name>.<ext>`, `.<infix>.<name>.<ext>`).
 */
export const classify = (ctx: ConfigDef.Context, name: string): FileKind | undefined => {
  if (ctx.dot && !name.startsWith('.')) {
    return undefined
  }

  const bare = ctx.dot ? name.slice(1) : name
  const anchor = `${ctx.name}.${ctx.ext}`

  if (bare === anchor) {
    return 'base'
  }

  if (bare.endsWith(`.${anchor}`)) {
    const infix = bare.slice(0, bare.length - anchor.length - 1)
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
