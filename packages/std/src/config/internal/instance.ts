import type { Operation } from 'std:effect'
import { attempt, createSignal, debounce, each, fork } from 'std:effect'
import { IO } from 'std:io'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'
import { flattenEntries, getPath, setPath, unsetPath } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

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
function* writeData(ctx: ConfigDef.Context, target: string, data: ConfigDef.Object) {
  const text = yield* ctx.codec.actions.stringify(data)
  yield* IO.actions.ensureDir(yield* IO.actions.dirname(target))
  yield* IO.actions.write(target, text)
}

/**
 * Build a config instance whose actions run against the context yielded by `getCtx`. The default
 * instance (`Config.actions.*`) reads the scope-installed context
 * (`() => useContext(ConfigImpl.context)`); `open` binds a private one instead.
 */
export const makeInstance = (getCtx: () => Operation<ConfigDef.Context>): ConfigDef.Instance => ({
  *load(cwd?: string) {
    const ctx = yield* getCtx()
    yield* rediscover(ctx, cwd ?? ctx.cwd)
  },

  *refresh() {
    const ctx = yield* getCtx()
    yield* rediscover(ctx, ctx.cwd)
  },

  *save(path?: string) {
    const ctx = yield* getCtx()

    // Explicit target: export the base working file's content (with its `extends`) to `path`. An
    // export leaves the sources dirty — only writing the working file to ITS OWN path persists it.
    if (path !== undefined) {
      yield* writeData(ctx, path, payloadOf(ctx.working))

      if (path === ctx.working.path) {
        ctx.dirty.delete(ctx.working.path)
      }

      return
    }

    // Otherwise persist every source file a set/remove/clear touched, back to its own path.
    for (const source of collectSources(sources(ctx))) {
      if (ctx.dirty.has(source.path)) {
        yield* writeData(ctx, source.path, payloadOf(source))
      }
    }
    ctx.dirty.clear()
  },

  *get(key?: string) {
    const ctx = yield* getCtx()
    return (key === undefined ? ctx.merged : getPath(ctx.merged, key)) as AnyType
  },

  *set(key: string, value: unknown) {
    const ctx = yield* getCtx()
    // Write into the file that already defines the key; new keys land in the base working file.
    const target = findOrigin(sources(ctx), key) ?? ctx.working
    target.data = setPath(target.data, key, value)
    ctx.dirty.add(target.path)
    // the set is what `get` answers from here on: an env overlay value for the key steps aside
    // for this session (`load` / `refresh` rebuild the overlay and restore its precedence)
    ctx.env = unsetPath(ctx.env, key)
    ctx.merged = merge(ctx)
  },

  *remove(key: string) {
    const ctx = yield* getCtx()
    // Remove from the file that currently provides the key (a shadowed copy below may re-surface).
    const target = findOrigin(sources(ctx), key)
    if (target === undefined) {
      return
    }
    target.data = unsetPath(target.data, key)
    ctx.dirty.add(target.path)
    ctx.merged = merge(ctx)
  },

  *clear() {
    const ctx = yield* getCtx()
    ctx.working.data = {}
    ctx.dirty.add(ctx.working.path)
    ctx.merged = merge(ctx)
  },

  *delete(path?: string) {
    const ctx = yield* getCtx()
    const target = path ?? ctx.working.path

    yield* IO.actions.rm(target, { force: true })
    yield* rediscover(ctx, ctx.cwd)
  },

  *search(query: string) {
    const ctx = yield* getCtx()
    const needle = query.toLowerCase()

    return flattenEntries(ctx.merged).filter(
      entry =>
        entry.key.toLowerCase().includes(needle) ||
        String(entry.value).toLowerCase().includes(needle),
    )
  },

  *tree() {
    const ctx = yield* getCtx()
    return ctx.chain
  },

  *has(key: string) {
    const ctx = yield* getCtx()
    return getPath(ctx.merged, key) !== undefined
  },

  *keys() {
    const ctx = yield* getCtx()
    return flattenEntries(ctx.merged).map(entry => entry.key)
  },

  *origin(key: string) {
    const ctx = yield* getCtx()
    return explainOf(ctx, key)[0]?.path
  },

  *explain(key: string) {
    const ctx = yield* getCtx()
    return explainOf(ctx, key)
  },

  // Watch via `watch` (event-based, no polling): each config directory (`DIR`) recursively, and every
  // other source file (base/variant/`extends`) directly. All events feed one debounced reloader that
  // re-discovers and notifies only when the merged view actually changes.
  *watch(listener: ConfigDef.Watcher, options?: ConfigDef.WatchOptions) {
    const ctx = yield* getCtx()
    const { recursiveDirs, files } = yield* watchTargets(ctx)

    // Every watcher event bumps a shared signal; `debounce` collapses a burst into one tick so a
    // single save (which fires several fs events) triggers just one re-discover.
    const bump = createSignal<void, never>()
    // Change detection pins JsonCodec deliberately: config treats an installed JsonCodec as a
    // baseline dependency, and canonical JSON is one deterministic fingerprint for the merged view
    // regardless of which codec the config FILES use.
    let last = yield* JsonCodec.actions.stringify(ctx.merged)

    const feed = (stream: ReturnType<typeof IO.actions.watch>) =>
      function* () {
        for (const _ of yield* each(stream)) {
          bump.send()
          yield* each.next()
        }
      }

    return yield* fork(function* () {
      for (const dir of recursiveDirs) {
        yield* fork(feed(IO.actions.watch(dir, { recursive: true })))
      }
      for (const file of files) {
        yield* fork(feed(IO.actions.watch(file)))
      }

      for (const _ of yield* each(debounce(bump, options?.debounce ?? 50))) {
        // a transient reload failure (e.g. an `extends` target briefly absent during an atomic
        // save/rename) must NOT kill the watcher — swallow it and keep watching; the next event retries
        const reloaded = yield* attempt(() => rediscover(ctx, ctx.cwd))
        if (isSuccess(reloaded)) {
          const next = yield* JsonCodec.actions.stringify(ctx.merged)
          if (next !== last) {
            last = next
            listener(ctx.merged)
          }
        }
        yield* each.next()
      }
    })
  },
})

/** The `open` action: a brand-new context + an instance bound to it (independent of the scope). */
export function* openInstance(options?: ConfigDef.Options) {
  const ctx = yield* buildContext(options)
  return makeInstance(constCtx(ctx))
}
