import type { Operation } from 'std:effect'
import { operation } from 'std:effect'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'
import { flattenEntries, getPath, setPath, unsetPath } from 'std:shared'

import { TomlCodec } from 'std:codec/impl/toml'

import { DEFAULT_NAME, Features } from '../const'
import type { ConfigDef } from '../types'

import { discover } from './discover'
import { buildEnvOverlay, homeDir, readVariant } from './env'
import { mergeChain } from './merge'
import { baseFile, codecExt } from './paths'

const constCtx = (ctx: ConfigDef.Context) =>
  operation(function* () {
    return ctx
  })

/** Build a fresh, unattached config context from options (the same shape the plugin `setup` returns). */
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
    chain: [],
    env: {},
    merged: {},
    working: { path: '', data: {} },
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
  ctx.merged = mergeChain(chain, ctx.env)
})

/**
 * Build a config instance whose actions run against the context yielded by `getCtx`. The default
 * instance reads the scope-installed context (`() => useContext(Config)`); `open` binds a private one.
 */
export const makeInstance = (
  getCtx: () => Operation<ConfigDef.Context, unknown>,
): ConfigDef.Instance => ({
  load: operation(function* (cwd?: string) {
    const ctx = yield* getCtx()
    yield* rediscover(ctx, cwd ?? ctx.cwd)
  }),

  refresh: operation(function* () {
    const ctx = yield* getCtx()
    yield* rediscover(ctx, ctx.cwd)
  }),

  save: operation(function* (path?: string) {
    const ctx = yield* getCtx()
    const target = path ?? ctx.working.path

    const text = yield* ctx.codec.actions.stringify(ctx.working.data)
    yield* IO.actions.ensureDir(yield* IO.actions.dirname(target))
    yield* IO.actions.write(target, text)
  }),

  get: operation(function* (key?: string) {
    const ctx = yield* getCtx()
    return (key === undefined ? ctx.merged : getPath(ctx.merged, key)) as AnyType
  }),

  set: operation(function* (key: string, value: unknown) {
    const ctx = yield* getCtx()
    ctx.working.data = setPath(ctx.working.data, key, value)
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  remove: operation(function* (key: string) {
    const ctx = yield* getCtx()
    ctx.working.data = unsetPath(ctx.working.data, key)
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  clear: operation(function* () {
    const ctx = yield* getCtx()
    ctx.working.data = {}
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  delete: operation(function* (path?: string) {
    const ctx = yield* getCtx()
    const target = path ?? ctx.working.path

    yield* IO.actions.rm(target, { force: true })
    yield* rediscover(ctx, ctx.cwd)
  }),

  search: operation(function* (query: string) {
    const ctx = yield* getCtx()
    const needle = query.toLowerCase()

    return flattenEntries(ctx.merged).filter(
      entry =>
        entry.key.toLowerCase().includes(needle) ||
        String(entry.value).toLowerCase().includes(needle),
    )
  }),

  tree: operation(function* () {
    const ctx = yield* getCtx()
    return ctx.chain
  }),
})

/** The `open` action: a brand-new context + an instance bound to it (independent of the scope). */
export const openInstance = operation(function* (options?: ConfigDef.Options) {
  const ctx = yield* buildContext(options)
  return makeInstance(constCtx(ctx))
})
