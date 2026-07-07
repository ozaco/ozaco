import { operation, useContext } from 'std:effect'
import { IO } from 'std:io'
import { definePlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'
import { flattenEntries, getPath, setPath, unsetPath } from 'std:shared'

import { TomlCodec } from 'std:codec/impl/toml'

import { DEFAULT_NAME, Features } from './const'
import { discover } from './internal/discover'
import { buildEnvOverlay, homeDir, readVariant } from './internal/env'
import { mergeChain } from './internal/merge'
import { baseFile, codecExt } from './internal/paths'
import type { ConfigDef } from './types'

/** (Re)discover the chain from `start`, recompute the env overlay + merged view, and pin the working file. */
const rediscover = operation(function* (ctx: ConfigDef.Context, start: string) {
  ctx.cwd = start
  ctx.variant = yield* readVariant(ctx)
  ctx.env = yield* buildEnvOverlay(ctx)

  const { chain, working } = yield* discover(ctx, start)
  ctx.chain = chain
  ctx.working = working
  ctx.merged = mergeChain(chain, ctx.env)
})

const ConfigImpl = definePlugin<ConfigDef.Context, unknown, [options?: ConfigDef.Options]>({
  name: 'std/config',
  version: '0.0.0',
  description: 'Hierarchical config discovery, merge, and edit',

  *setup(options) {
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
      chain: [],
      env: {},
      merged: {},
      working: { path: '', data: {} },
    }

    context.working.path = yield* IO.actions.join(cwd, baseFile(context))
    return context
  },
})

/**
 * The config plugin: discovers `<name>.<ext>` files from `cwd` up to `home`, resolves `extends`, and
 * merges them (plus fragments/variant/config-dir and an env overlay) into one view. Requires an `IO`
 * impl and a codec installed first. Precedence per level: variant → fragments → dir → base; inner
 * levels win over outer; the env overlay wins over all.
 */
export const Config = ConfigImpl.build<ConfigDef.Actions>({
  load: operation(function* (cwd?: string) {
    const ctx = yield* useContext(ConfigImpl.context)
    yield* rediscover(ctx, cwd ?? ctx.cwd)
  }),

  refresh: operation(function* () {
    const ctx = yield* useContext(ConfigImpl.context)
    yield* rediscover(ctx, ctx.cwd)
  }),

  save: operation(function* (path?: string) {
    const ctx = yield* useContext(ConfigImpl.context)
    const target = path ?? ctx.working.path

    const text = yield* ctx.codec.actions.stringify(ctx.working.data)
    yield* IO.actions.ensureDir(yield* IO.actions.dirname(target))
    yield* IO.actions.write(target, text)
  }),

  get: operation(function* (key?: string) {
    const ctx = yield* useContext(ConfigImpl.context)
    const result = key === undefined ? ctx.merged : getPath(ctx.merged, key)
    return result as AnyType
  }),

  set: operation(function* (key: string, value: unknown) {
    const ctx = yield* useContext(ConfigImpl.context)
    ctx.working.data = setPath(ctx.working.data, key, value)
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  remove: operation(function* (key: string) {
    const ctx = yield* useContext(ConfigImpl.context)
    ctx.working.data = unsetPath(ctx.working.data, key)
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  clear: operation(function* () {
    const ctx = yield* useContext(ConfigImpl.context)
    ctx.working.data = {}
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  delete: operation(function* (path?: string) {
    const ctx = yield* useContext(ConfigImpl.context)
    const target = path ?? ctx.working.path

    yield* IO.actions.rm(target, { force: true })
    yield* rediscover(ctx, ctx.cwd)
  }),

  search: operation(function* (query: string) {
    const ctx = yield* useContext(ConfigImpl.context)
    const needle = query.toLowerCase()

    return flattenEntries(ctx.merged).filter(
      entry =>
        entry.key.toLowerCase().includes(needle) ||
        String(entry.value).toLowerCase().includes(needle),
    )
  }),

  tree: operation(function* () {
    const ctx = yield* useContext(ConfigImpl.context)
    return ctx.chain
  }),
})
