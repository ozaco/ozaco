import { definePolicy, PolicyPriority } from 'server:core'
import type { PolicyDispatch } from 'server:core'

import type { CacheEntry, CacheOptions, CacheOverride, CacheState } from './types'

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX = 1000

const overrideOf = (override: object | boolean | undefined): CacheOverride | undefined =>
  typeof override === 'object' ? (override as CacheOverride) : undefined

const keyOf = (ctx: PolicyDispatch, vary: 'principal' | 'none'): string =>
  vary === 'principal' ? `${ctx.key}\0${ctx.principal ?? ''}` : ctx.key

/** Lazy sweep: drop expired entries, then evict oldest-first until there is room for one more. */
const makeRoom = (entries: Map<string, CacheEntry>, max: number): void => {
  const now = Date.now()

  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(key)
    }
  }

  while (entries.size >= max) {
    const oldest = entries.keys().next()

    if (oldest.done) {
      return
    }

    entries.delete(oldest.value)
  }
}

/**
 * The caching layer (outermost, `PolicyPriority.cache`): repeated dispatches with the same key are
 * served from a scope-bound TTL'd map without touching the rest of the onion. OPT-IN by default —
 * only actions declaring `policies: { cache: … }` are cached unless the policy is installed with
 * `global: true` (per-request values like the trace requestId would otherwise freeze inside cached
 * bodies while the edge keeps stamping fresh headers). Only `value` replies are ever cached —
 * streams and failures always pass through — and entries vary per principal by default. Streaming
 * dispatches skip the layer unless the action opts in.
 */
export const CachePolicy = definePolicy<CacheOptions, CacheState>({
  name: 'cache',
  priority: PolicyPriority.cache,
  skipStreaming: true,
  *setup(options) {
    return {
      entries: new Map<string, CacheEntry>(),
      global: options.global ?? false,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      max: options.max ?? DEFAULT_MAX,
      vary: options.vary ?? 'principal',
    }
  },
  *apply({ ctx, state, override, next }) {
    if (override === undefined && !state.global) {
      return yield* next()
    }

    const tuned = overrideOf(override)
    const ttlMs = tuned?.ttlMs ?? state.ttlMs
    const vary = tuned?.vary ?? state.vary
    const key = keyOf(ctx, vary)
    const hit = state.entries.get(key)

    if (hit) {
      if (hit.expiresAt > Date.now()) {
        return hit.reply
      }

      state.entries.delete(key)
    }

    const reply = yield* next()

    if (reply.kind === 'value' && ttlMs > 0) {
      makeRoom(state.entries, state.max)
      state.entries.set(key, { reply, expiresAt: Date.now() + ttlMs })
    }

    return reply
  },
})
