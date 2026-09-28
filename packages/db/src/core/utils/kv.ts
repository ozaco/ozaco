import type { Operation } from 'std:effect'
import { attempt, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { Kv } from '../definition/protocol'
import { KvErrors } from '../errors'
import { DEFAULT_KEYS_LIMIT } from '../internal/const'
import { decode, encode, namespacedKey, namespacedTag, tell } from '../internal/kv'
import { kvSpan } from '../internal/trace'
import type { KvDef } from '../types/kv'

/** A prefix follows the same rules as a topic segment: non-empty, no `:` (the separator). */
export const isValidKvPrefix = (prefix: string): boolean =>
  prefix.length > 0 && !prefix.includes(':')

/**
 * Assemble the store actions over a byte driver. `driver` functions read the impl's own
 * scope-bound state, so one factory call per impl module serves every install of it. The install
 * prefix is read from the dispatched impl's context on every call. Every op runs in its child-only
 * `{op} kv` span (see `internal/trace`); `wrap` has none of its own — its `get` and `set` do, and a
 * miss computes under the caller's span.
 */
export const kvActions = (driver: KvDef.Driver): KvDef.Actions => {
  /** in-process singleflight: one computation per (prefix, key) at a time; its outcome, or `null`
   * when the leader was halted before it settled. */
  const inflight = new Map<string, Operation<Result<unknown> | null>>()

  const prefixOf = function* () {
    return (yield* Kv.context.expect()).prefix
  }

  const keyOf = function* (key: string) {
    return namespacedKey(yield* prefixOf(), key)
  }

  const tagsOf = function* (tags: readonly string[] | undefined) {
    const prefix = yield* prefixOf()

    return (tags ?? []).map(tag => namespacedTag(prefix, tag))
  }

  const read = function* <T>(key: string): Operation<T | undefined> {
    const data = yield* driver.get(yield* keyOf(key))

    return data === null ? undefined : yield* decode<T>(key, data)
  }

  const write = function* <T>(key: string, value: T, options?: KvDef.SetOptions): Operation<void> {
    yield* driver.set({
      key: yield* keyOf(key),
      data: yield* encode(value),
      ttlMs: options?.ttlMs ?? null,
      tags: yield* tagsOf(options?.tags),
    })
  }

  const get = <T>(key: string): Operation<T | undefined> => kvSpan('get', () => read<T>(key))

  const set = <T>(key: string, value: T, options?: KvDef.SetOptions): Operation<void> =>
    kvSpan('set', () => write(key, value, options))

  return {
    get,
    set,

    del: (...keys) =>
      kvSpan(
        'del',
        function* () {
          const full: string[] = []

          for (const key of keys) {
            full.push(yield* keyOf(key))
          }

          return full.length === 0 ? 0 : yield* driver.del(full)
        },
        keys.length,
      ),
    has: key =>
      kvSpan('has', function* () {
        return yield* driver.has(yield* keyOf(key))
      }),
    ttl: key =>
      kvSpan('ttl', function* () {
        return yield* driver.ttl(yield* keyOf(key))
      }),
    expire: (key, ttlMs) =>
      kvSpan('expire', function* () {
        return yield* driver.expire(yield* keyOf(key), ttlMs)
      }),
    incr: (key, by, options) =>
      kvSpan('incr', function* () {
        return yield* driver.incr(yield* keyOf(key), by ?? 1, options?.ttlMs ?? null)
      }),

    mget: keys =>
      kvSpan(
        'mget',
        function* () {
          const out: unknown[] = []

          for (const key of keys) {
            out.push(yield* read(key))
          }

          // `mget<T>`'s T lives on the interface method — caller-asserted, like every Kv generic
          return out as AnyType
        },
        keys.length,
      ),
    mset: (entries, options) =>
      kvSpan(
        'mset',
        function* () {
          for (const [key, value] of entries) {
            yield* write(key, value, options)
          }
        },
        entries.length,
      ),

    keys: (prefix, options) =>
      kvSpan('keys', function* () {
        if (!driver.capabilities.scan) {
          return yield* fail(KvErrors.Unsupported, 'this store cannot enumerate keys')
        }

        const base = yield* prefixOf()

        const page = yield* driver.keys(namespacedKey(base, prefix ?? ''), {
          limit: Math.max(1, Math.trunc(options?.limit ?? DEFAULT_KEYS_LIMIT)),
          cursor: options?.cursor,
        })
        const head = `${base}:`

        return {
          keys: page.keys.map(key => (key.startsWith(head) ? key.slice(head.length) : key)),
          cursor: page.cursor,
        }
      }),
    invalidate: (...tags) =>
      kvSpan(
        'invalidate',
        function* () {
          return tags.length === 0 ? 0 : yield* driver.invalidate(yield* tagsOf(tags))
        },
        tags.length,
      ),

    *wrap<T>(key: string, options: KvDef.WrapOptions, compute: () => Operation<T>) {
      const full = yield* keyOf(key)

      // a follower whose leader was halted goes round again: the stored value, the next flight,
      // or it leads itself
      for (;;) {
        const cached = yield* get<T>(key)

        if (cached !== undefined) {
          tell(options, 'hit')

          return cached
        }

        const running = inflight.get(full)

        if (!running) {
          break
        }

        // someone in this process is already computing it: share the outcome
        tell(options, 'coalesced')

        const shared = yield* running

        if (shared !== null) {
          return isFailure(shared) ? yield* shared : (shared.value as T)
        }
      }

      tell(options, 'miss')

      const settled = withResolvers<Result<unknown> | null>('kv wrap')
      const flight = settled.operation

      inflight.set(full, flight)

      let outcome: Result<unknown> | null = null

      try {
        outcome = yield* attempt(function* () {
          const value = yield* compute()

          yield* set(key, value, options)

          return value
        })
      } finally {
        if (inflight.get(full) === flight) {
          inflight.delete(full)
        }

        // `null` ⇒ halted before it settled: the followers go round again (never left hanging)
        settled.resolve(outcome)
      }

      return isFailure(outcome) ? yield* outcome : (outcome.value as T)
    },

    clear: () =>
      kvSpan('clear', function* () {
        return yield* driver.clear(`${yield* prefixOf()}:`)
      }),
  }
}
