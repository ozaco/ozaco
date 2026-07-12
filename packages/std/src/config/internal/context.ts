import { operation } from 'std:effect'
import { IO } from 'std:io'

import { TomlCodec } from 'std:codec/impl/toml'

import { DEFAULT_NAME, Features } from '../const'
import type { ConfigDef } from '../types'

import { discover } from './discover'
import { buildEnvOverlay, homeDir, readVariant } from './env'
import { baseFile, codecExt, merge } from './utils'

/** Build a fresh, unattached config context from options (the shape the plugin `setup` returns). */
export const buildContext = operation(function* (options?: ConfigDef.Options) {
  const codec = options?.codec ?? TomlCodec
  const name = options?.name ?? DEFAULT_NAME
  const dot = options?.dot ?? true
  const ext = options?.ext ?? codecExt(codec)
  const cwd = options?.cwd ?? process.cwd()

  const context: ConfigDef.Context = {
    name,
    cwd,
    dot,
    ext,
    codec,
    home: options?.home ?? (yield* homeDir()),
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
})

/** (Re)discover the chain from `start`, recompute the env overlay + merged view, pin the working file. */
export const rediscover = operation(function* (ctx: ConfigDef.Context, start: string) {
  ctx.cwd = start
  ctx.variant = yield* readVariant(ctx)
  ctx.env = yield* buildEnvOverlay(ctx)

  const { chain, working } = yield* discover(ctx, start)
  ctx.chain = chain
  ctx.working = working
  ctx.merged = merge(ctx)
  ctx.dirty.clear()
})
