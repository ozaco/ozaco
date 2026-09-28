import { DbClient, Kv } from 'db:core'
import type { ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { attempt, fork, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../../package.json'

import { evict, follow, lookup, options } from './internal'
import type { CacheDef } from './types'

/**
 * Response caching over the installed `Kv` store: `action.query({ cache: { ttlMs, vary, tags } })`
 * serves repeats from the store (singleflight on a miss — one computation per key), a mutation's
 * `invalidate: [tags]` drops entries once it succeeds, and every db table named as a tag is
 * invalidated automatically when that table changes (the db's change feed — cluster-wide through
 * the bus). Stream outputs are never cached.
 *
 * Telemetry (scope `@ozaco/server/cache`): every lookup is an INTERNAL `cache {service}.{action}`
 * span (`ozaco.cache.hit` / `.coalesced` / `.key` / `.store` / `.ttl_ms`) the handler runs under on
 * a miss; a hit links the span that computed the entry (`cache.producer`). A mutation's
 * invalidation is an `cache.evict` event on its span; a change-feed invalidation is a
 * `record: 'errors'` root `cache.invalidate {table}` linking the write (`change.writer`).
 * Swallowed failures (an invalidation, a feed) are logged through the std Logger (WARN).
 */
export const Cache = definePlugin<ServerDef.PluginContext, [options?: CacheDef.PluginOptions]>({
  name: 'server-cache',
  version: pkg.version,
  description: 'Response cache over the Kv store with tag + db-change invalidation',

  *setup(given) {
    const kernel = yield* Server.context.get()

    if (!kernel) {
      return yield* fail(ServerErrors.Configuration, 'Cache must be installed by createServer')
    }

    if (isFailure(yield* attempt(() => useContext(Kv)))) {
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
            return yield* lookup({ prefix, call, ctx, cache, next })
          }

          const value = yield* next(call, ctx)

          if (invalidate) {
            yield* evict(invalidate)
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
            yield* fork(() => follow(() => (db as AnyType).changes(table), table))
          }
        },
      },
    }
  },
}).build()
