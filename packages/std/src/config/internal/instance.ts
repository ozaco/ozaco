import type { Operation } from 'std:effect'
import { createSignal, debounce, each, operation, spawn } from 'std:effect'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'
import { flattenEntries, getPath, setPath, unsetPath } from 'std:shared'

import type { ConfigDef } from '../types'

import { buildContext, rediscover } from './context'
import {
  collectSources,
  constCtx,
  explainOf,
  findOrigin,
  merge,
  payloadOf,
  sources,
  watchTargets,
} from './utils'

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

    // Explicit target: export the base working file's content (with its `extends`) to `path`.
    if (path !== undefined) {
      yield* writeData(ctx, path, payloadOf(ctx.working))
      return
    }

    // Otherwise persist every source file a set/remove/clear touched, back to its own path.
    for (const source of collectSources(sources(ctx))) {
      if (ctx.dirty.has(source.path)) {
        yield* writeData(ctx, source.path, payloadOf(source))
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
    const target = findOrigin(sources(ctx), key) ?? ctx.working
    target.data = setPath(target.data, key, value)
    ctx.dirty.add(target.path)
    ctx.merged = merge(ctx)
  }),

  remove: operation(function* (key: string) {
    const ctx = yield* getCtx()
    // Remove from the file that currently provides the key (a shadowed copy below may re-surface).
    const target = findOrigin(sources(ctx), key)
    if (target === undefined) {
      return
    }
    target.data = unsetPath(target.data, key)
    ctx.dirty.add(target.path)
    ctx.merged = merge(ctx)
  }),

  clear: operation(function* () {
    const ctx = yield* getCtx()
    ctx.working.data = {}
    ctx.dirty.add(ctx.working.path)
    ctx.merged = merge(ctx)
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

  has: operation(function* (key: string) {
    const ctx = yield* getCtx()
    return getPath(ctx.merged, key) !== undefined
  }),

  keys: operation(function* () {
    const ctx = yield* getCtx()
    return flattenEntries(ctx.merged).map(entry => entry.key)
  }),

  origin: operation(function* (key: string) {
    const ctx = yield* getCtx()
    return explainOf(ctx, key)[0]?.path
  }),

  explain: operation(function* (key: string) {
    const ctx = yield* getCtx()
    return explainOf(ctx, key)
  }),

  // Watch via `watch` (event-based, no polling): each config directory (`DIR`) recursively, and every
  // other source file (base/variant/`extends`) directly. All events feed one debounced reloader that
  // re-discovers and notifies only when the merged view actually changes.
  watch: operation(function* (listener: ConfigDef.Watcher, options?: ConfigDef.WatchOptions) {
    const ctx = yield* getCtx()
    const { recursiveDirs, files } = yield* watchTargets(ctx)

    // Every watcher event bumps a shared signal; `debounce` collapses a burst into one tick so a
    // single save (which fires several fs events) triggers just one re-discover.
    const bump = createSignal<void, never>()
    let last = JSON.stringify(ctx.merged)

    const feed = (stream: ReturnType<typeof IO.actions.watch>) =>
      operation(function* () {
        for (const _ of yield* each(stream)) {
          bump.send()
          yield* each.next()
        }
      })

    return yield* spawn(function* () {
      for (const dir of recursiveDirs) {
        yield* spawn(feed(IO.actions.watch(dir, { recursive: true })))
      }
      for (const file of files) {
        yield* spawn(feed(IO.actions.watch(file)))
      }

      for (const _ of yield* each(debounce(bump, options?.debounce ?? 50))) {
        yield* rediscover(ctx, ctx.cwd)
        const next = JSON.stringify(ctx.merged)
        if (next !== last) {
          last = next
          listener(ctx.merged)
        }
        yield* each.next()
      }
    })
  }),
})

/** The `open` action: a brand-new context + an instance bound to it (independent of the scope). */
export const openInstance = operation(function* (options?: ConfigDef.Options) {
  const ctx = yield* buildContext(options)
  return makeInstance(constCtx(ctx))
})
