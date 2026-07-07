import { operation } from 'std:effect'
import { IO } from 'std:io'
import { hasFlag, setPath } from 'std:shared'

import { Features, VARIANT_ENV_KEY } from '../const'
import type { ConfigDef } from '../types'

/** Read all env vars as a plain (possibly sparse) record. */
const readEnv = operation(function* () {
  return (yield* IO.actions.env(data => data)) as Record<string, string | undefined>
})

/** Coerce an env string into a boolean/number when it looks like one, else keep the string. */
const coerce = (value: string): unknown => {
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

/** The home directory, from `HOME`/`USERPROFILE` (empty string ⇒ discovery walks to the fs root). */
export const homeDir = operation(function* () {
  const env = yield* readEnv()
  return env.HOME ?? env.USERPROFILE ?? ''
})

/** The active variant: an explicit one wins; otherwise `STD_CONFIG` when the `ENV` feature is on. */
export const readVariant = operation(function* (ctx: ConfigDef.Context) {
  if (ctx.variant) {
    return ctx.variant
  }
  if (!hasFlag(ctx.features, Features.ENV)) {
    return undefined
  }

  const env = yield* readEnv()
  return env[VARIANT_ENV_KEY] || undefined
})

/**
 * Build the env overlay (`ENV` feature): every `<NAME>_A_B` var becomes the dotted key `a.b` with a
 * coerced value. Empty when the feature is off.
 */
export const buildEnvOverlay = operation(function* (ctx: ConfigDef.Context) {
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
})
