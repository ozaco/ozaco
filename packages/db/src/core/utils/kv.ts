// oxlint-disable import/exports-last
import { Codec } from 'std:codec'
import type { Operation } from 'std:effect'
import { attempt, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { Kv } from '../definition/protocol'
import { KvErrors } from '../errors'
import type { KvDef } from '../types/kv'

const DEFAULT_KEYS_LIMIT = 100
const TAG_SEGMENT = '$tag'

/** A prefix follows the same rules as a topic segment: non-empty, no `:` (the separator). */
export const isValidKvPrefix = (prefix: string): boolean =>
  prefix.length > 0 && !prefix.includes(':')

/** The namespaced form of a key / tag set under an install prefix. */
const namespacedKey = (prefix: string, key: string): string => `${prefix}:${key}`
const namespacedTag = (prefix: string, tag: string): string => `${prefix}:${TAG_SEGMENT}:${tag}`

function* encode(value: unknown) {
  const encoded = yield* attempt(() => Codec.actions.encode(value))

  if (isFailure(encoded)) {
    return yield* fail(KvErrors.Encoding, 'cannot encode value', String(encoded.error))
  }

  return encoded.value
}

function* decode<T>(key: string, data: Uint8Array) {
  const decoded = yield* attempt(() => Codec.actions.decode<T>(data))

  if (isFailure(decoded)) {
    return yield* fail(
      KvErrors.Encoding,
      `cannot decode value under "${key}"`,
      String(decoded.error),
    )
  }

  return decoded.value
}

/**
 * Assemble the store actions over a byte driver. `driver` functions read the impl's own
 * scope-bound state, so one factory call per impl module serves every install of it. The install
 * prefix is read from the dispatched impl's context on every call.
 */
export const kvActions = (driver: KvDef.Driver): KvDef.Actions => {
  /** in-process singleflight: one computation per (prefix, key) at a time. */
  const inflight = new Map<string, Operation<Result<unknown>>>()

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

  const get = function* <T>(key: string): Operation<T | undefined> {
    const data = yield* driver.get(yield* keyOf(key))
    return data === null ? undefined : yield* decode<T>(key, data)
  }

  const set = function* <T>(key: string, value: T, options?: KvDef.SetOptions): Operation<void> {
    yield* driver.set({
      key: yield* keyOf(key),
      data: yield* encode(value),
      ttlMs: options?.ttlMs ?? null,
      tags: yield* tagsOf(options?.tags),
    })
  }

  return {
    get,
    set,

    *del(...keys) {
      const full: string[] = []

      for (const key of keys) {
        full.push(yield* keyOf(key))
      }

      return full.length === 0 ? 0 : yield* driver.del(full)
    },
    *has(key) {
      return yield* driver.has(yield* keyOf(key))
    },
    *ttl(key) {
      return yield* driver.ttl(yield* keyOf(key))
    },
    *expire(key, ttlMs) {
      return yield* driver.expire(yield* keyOf(key), ttlMs)
    },
    *incr(key, by, options) {
      return yield* driver.incr(yield* keyOf(key), by ?? 1, options?.ttlMs ?? null)
    },

    *mget(keys) {
      const out: unknown[] = []

      for (const key of keys) {
        out.push(yield* get(key))
      }

      // `mget<T>`'s T lives on the interface method — caller-asserted, like every Kv generic
      return out as AnyType
    },
    *mset(entries, options) {
      for (const [key, value] of entries) {
        yield* set(key, value, options)
      }
    },

    *keys(prefix, options) {
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
    },
    *invalidate(...tags) {
      return tags.length === 0 ? 0 : yield* driver.invalidate(yield* tagsOf(tags))
    },

    *wrap<T>(key: string, options: KvDef.WrapOptions, compute: () => Operation<T>) {
      const cached = yield* get<T>(key)

      if (cached !== undefined) {
        return cached
      }

      const full = yield* keyOf(key)
      const running = inflight.get(full)

      if (running) {
        // someone in this process is already computing it: share the outcome
        const outcome = yield* running

        if (isFailure(outcome)) {
          return yield* outcome
        }

        return outcome.value as T
      }

      const settled = withResolvers<Result<unknown>>('kv wrap')
      inflight.set(full, settled.operation)

      const outcome = yield* attempt(function* () {
        const value = yield* compute()
        yield* set(key, value, options)
        return value
      })
      inflight.delete(full)
      settled.resolve(outcome as Result<unknown>)

      if (isFailure(outcome)) {
        return yield* outcome
      }

      return outcome.value as T
    },

    *clear() {
      return yield* driver.clear(`${yield* prefixOf()}:`)
    },
  }
}
