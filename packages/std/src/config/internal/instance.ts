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

/** Every source, chain + `extends`, highest precedence first (own data wins, later extends win). */
const collectSources = (sources: ConfigDef.Source[]): ConfigDef.Source[] =>
  sources.flatMap(source => [source, ...collectSources(source.extends.toReversed())])

/**
 * The source file `key` should be written to: the highest-precedence file that already defines the
 * key or its nearest existing ancestor path — so `set('a.b.c')` lands in the file that owns `a.b`, or
 * failing that `a`. `undefined` when no file mentions any ancestor (the caller falls back to the base
 * working file, where genuinely new top-level keys belong).
 */
const findOrigin = (sources: ConfigDef.Source[], key: string): ConfigDef.Source | undefined => {
  const flat = collectSources(sources)
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

/** Serialize `data` with the context codec and write it to `target`, creating parent dirs. */
const writeData = operation(function* (
  ctx: ConfigDef.Context,
  target: string,
  data: ConfigDef.Object,
) {
  const text = yield* ctx.codec.actions.stringify(data)
  yield* IO.actions.ensureDir(yield* IO.actions.dirname(target))
  yield* IO.actions.write(target, text)
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
  ctx.merged = mergeChain(chain, ctx.env)
  ctx.dirty.clear()
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

    // Explicit target: export the base working file's content to `path`.
    if (path !== undefined) {
      yield* writeData(ctx, path, ctx.working.data)
      return
    }

    // Otherwise persist every source file a set/remove/clear touched, back to its own path.
    for (const source of collectSources(ctx.chain)) {
      if (ctx.dirty.has(source.path)) {
        yield* writeData(ctx, source.path, source.data)
      }
    }
    ctx.dirty.clear()
  }),

  get: operation(function* (key?: string) {
    const ctx = yield* getCtx()
    return (key === undefined ? ctx.merged : getPath(ctx.merged, key)) as AnyType
  }),

  set: operation(function* (key: string, value: unknown) {
    const ctx = yield* getCtx()
    // Write into the file that already defines the key; new keys land in the base working file.
    const target = findOrigin(ctx.chain, key) ?? ctx.working
    target.data = setPath(target.data, key, value)
    ctx.dirty.add(target.path)
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  remove: operation(function* (key: string) {
    const ctx = yield* getCtx()
    // Remove from the file that currently provides the key (a shadowed copy below may re-surface).
    const target = findOrigin(ctx.chain, key)
    if (target === undefined) {
      return
    }
    target.data = unsetPath(target.data, key)
    ctx.dirty.add(target.path)
    ctx.merged = mergeChain(ctx.chain, ctx.env)
  }),

  clear: operation(function* () {
    const ctx = yield* getCtx()
    ctx.working.data = {}
    ctx.dirty.add(ctx.working.path)
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
