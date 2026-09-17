import { attempt, useContext } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { TomlCodec } from 'std:codec/impl/toml'

import { DEFAULT_NAME, Features } from '../const'
import { ConfigErrors } from '../errors'
import type { ConfigDef } from '../types'

import { discover } from './discover'
import { buildEnvOverlay, homeOrRoot, readVariant } from './env'
import { baseFile, merge } from './utils'

/** The extension the codec declares for its documents — the codec must be installed in this
 * scope (its actions are needed to read the files anyway). */
function* extOf(codec: NonNullable<ConfigDef.Options['codec']>) {
  const codecCtx = yield* attempt(() => useContext(codec))

  if (isFailure(codecCtx) || !codecCtx.value.ext) {
    return yield* fail(
      ConfigErrors.Configuration,
      `install the config codec (${codec.name}) before Config, or pass options.ext`,
    )
  }

  return codecCtx.value.ext
}

/** Build a fresh, unattached config context from options (the shape the plugin `setup` returns). */
export function* buildContext(options?: ConfigDef.Options) {
  const codec = options?.codec ?? TomlCodec
  const name = options?.name ?? DEFAULT_NAME
  const dot = options?.dot ?? true
  const ext = options?.ext ?? (yield* extOf(codec))
  const cwd = options?.cwd ?? (yield* IO.actions.cwd())

  const context: ConfigDef.Context = {
    name,
    cwd,
    dot,
    ext,
    codec,
    home: options?.home ?? (yield* homeOrRoot()),
    features: options?.features ?? Features.ALL,
    variant: options?.variant,
    variantOption: options?.variant,
    chain: [],
    env: {},
    merged: {},
    working: { path: '', data: {}, extends: [] },
    dirty: new Set<string>(),
  }

  context.working.path = yield* IO.actions.join(cwd, baseFile(context))
  return context
}

/** (Re)discover the chain from `start`, recompute the env overlay + merged view, pin the working file. */
export function* rediscover(ctx: ConfigDef.Context, start: string) {
  ctx.cwd = start
  ctx.variant = yield* readVariant(ctx)
  ctx.env = yield* buildEnvOverlay(ctx)

  const { chain, working } = yield* discover(ctx, start)
  ctx.chain = chain
  ctx.working = working
  ctx.merged = merge(ctx)
  ctx.dirty.clear()
}
