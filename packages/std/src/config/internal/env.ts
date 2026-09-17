import { attempt } from 'std:effect'
import { IO } from 'std:io'
import { isSuccess } from 'std:result'
import { hasFlag, setPath } from 'std:shared'

import { Features, VARIANT_ENV_KEY } from '../const'
import type { ConfigDef } from '../types'

import { coerce } from './utils'

/** Read all env vars as a plain (possibly sparse) record. */
function* readEnv() {
  return (yield* IO.actions.env(data => data)) as Record<string, string | undefined>
}

/** Where discovery stops (inclusive): the user's home from `IO.actions.homeDir()`; the empty
 * string where the runtime has no home (the browser) ⇒ discovery walks to the fs root. */
export function* homeOrRoot() {
  const home = yield* attempt(() => IO.actions.homeDir())
  return isSuccess(home) ? home.value : ''
}

/** The active variant: an explicit OPTION wins; otherwise `STD_CONFIG` when the `ENV` feature is on.
 * Gates on `ctx.variantOption` (the raw option), NOT the mutated `ctx.variant`, so a reload always
 * re-derives the env variant instead of latching the value stored on the first discovery. */
export function* readVariant(ctx: ConfigDef.Context) {
  if (ctx.variantOption) {
    return ctx.variantOption
  }
  if (!hasFlag(ctx.features, Features.ENV)) {
    return undefined
  }

  const env = yield* readEnv()
  return env[VARIANT_ENV_KEY] || undefined
}

/**
 * Build the env overlay (`ENV` feature): every `<NAME>_A_B` var becomes the dotted key `a.b` with a
 * coerced value. Empty when the feature is off. Applied as the highest-precedence source.
 */
export function* buildEnvOverlay(ctx: ConfigDef.Context) {
  if (!hasFlag(ctx.features, Features.ENV)) {
    return {} as ConfigDef.Object
  }

  const prefix = `${ctx.name.toUpperCase()}_`
  const env = yield* readEnv()

  let overlay: ConfigDef.Object = {}
  for (const key of Object.keys(env)) {
    if (!key.startsWith(prefix)) {
      continue
    }

    const value = env[key]
    if (value === undefined) {
      continue
    }

    const path = key.slice(prefix.length).toLowerCase().split('_').filter(Boolean).join('.')
    if (path) {
      overlay = setPath(overlay, path, coerce(value))
    }
  }

  return overlay
}
