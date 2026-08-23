import { DbClient, Kv } from 'db:core'
import type { ServerDef } from 'server:core'
import { childTrace, Server, ServerErrors, withSpan } from 'server:core'
import { attempt, fork } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { keyOf, options } from './internal'
import type { CacheDef } from './types'

/**
 * Response caching over the installed `Kv` store: `action.query({ cache: { ttlMs, vary, tags } })`
 * serves repeats from the store (singleflight on a miss — one computation per key), a mutation's
 * `invalidate: [tags]` drops entries once it succeeds, and every db table named as a tag is
 * invalidated automatically when that table changes (the db's change feed — cluster-wide through
 * the bus). Stream outputs are never cached. Every lookup is a `cache` span (hit/miss).
 */
export const Cache = definePlugin<ServerDef.PluginContext, [options?: CacheDef.PluginOptions]>({
  name: 'server-cache',
  version: '0.5.0',
  description: 'Response cache over the Kv store with tag + db-change invalidation',

  *setup(given) {
    const kernel = yield* Server.context.get()
    if (!kernel) {
      return yield* fail(ServerErrors.Configuration, 'Cache must be installed by createServer')
    }
    if (isFailure(yield* attempt(() => Kv.actions.describe()))) {
      return yield* fail(
        ServerErrors.Configuration,
        'Cache needs a Kv store installed before createServer (MemoryKv / RedisKv)',
      )
    }
    const prefix = given?.prefix ?? 'cache'
    return {
      options,
      hooks: {
        name: 'cache',
        *dispatch(call, ctx, next) {
          const cache = (ctx.meta.options as { cache?: CacheDef.Options }).cache
          const invalidate = (ctx.meta.options as { invalidate?: readonly string[] }).invalidate
          if (cache && ctx.meta.outputPlane === 'value') {
            const key = keyOf({ prefix, call, ctx, cache })
            const hit = yield* Kv.actions.has(key)
            return yield* withSpan(
              {
                kernel,
                trace: yield* childTrace(call.trace),
                kind: 'cache',
                name: hit ? 'hit' : 'miss',
                attrs: { key },
              },
              () =>
                Kv.actions.wrap(key, { ttlMs: cache.ttlMs, tags: cache.tags }, () =>
                  next(call, ctx),
                ),
            )
          }
          const value = yield* next(call, ctx)
          if (invalidate) {
            yield* Kv.actions.invalidate(...invalidate)
          }
          return value
        },
        *start() {
          if (given?.tables === false) {
            return
          }
          const db = yield* DbClient.context.get()
          if (!db) {
            return
          }
          // every tag that names a declared table follows that table's change feed
          const tagged = new Set<string>()
          for (const def of kernel.registry.actions.values()) {
            for (const tag of (def.meta.options as { cache?: CacheDef.Options }).cache?.tags ??
              []) {
              tagged.add(tag)
            }
          }
          const tables = (given?.tables ?? [...tagged]).filter(name => tagged.has(name))
          for (const table of tables) {
            yield* fork(function* () {
              const feed = yield* attempt(() => (db as AnyType).changes(table))
              if (isFailure(feed)) {
                return
              }
              for (;;) {
                const step = yield* (feed.value as AnyType).next()
                if (step.done) {
                  return
                }
                yield* attempt(() => Kv.actions.invalidate(table))
              }
            })
          }
        },
      },
    }
  },
}).build()
