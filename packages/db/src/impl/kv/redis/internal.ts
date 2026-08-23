// oxlint-disable import/exports-last
import type { KvDef } from 'db:core'
import { KvErrors } from 'db:core'
import { attempt, createContext, until, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { RedisKvDef } from './types'

export const StateRef = createContext<RedisKvDef.State>('db:impl/kv/redis')

const encoder = new TextEncoder()

export const raise = function* (error: unknown) {
  return yield* fail(KvErrors.Connection, String((error as AnyType)?.message ?? error))
}

/** Await a client promise, classifying a rejection into a `kv.connection` failure. */
function* call<T>(promise: Promise<T>) {
  const state = yield* useContext(StateRef)

  if (state.closed) {
    return yield* fail(KvErrors.Connection, 'redis client closed')
  }

  const outcome = yield* attempt(until(promise))

  if (isFailure(outcome)) {
    return yield* raise(outcome.error)
  }

  return outcome.value
}

const toBytes = (value: AnyType): Uint8Array =>
  value instanceof Uint8Array ? value : encoder.encode(String(value))

/** The companion set holding a value's tags (so a re-set drops its old memberships). A key
 * ending in `::tags` is therefore reserved. */
const TAGS_SUFFIX = '::tags'
const tagsKeyOf = (key: string): string => key + TAGS_SUFFIX

/** Escape glob metacharacters so a namespace prefix matches literally in `SCAN MATCH`. */
const globEscape = (text: string): string => text.replaceAll(/[*?[\]\\]/gu, String.raw`\$&`)

export const driver: KvDef.Driver = {
  capabilities: { persistent: true, atomic: true, scan: true },

  *get(key) {
    const { bytes } = yield* useContext(StateRef)
    const value = yield* call(bytes.get(key) as Promise<AnyType>)

    return value === null || value === undefined ? null : toBytes(value)
  },

  *set(entry) {
    const { client } = yield* useContext(StateRef)
    const companion = tagsKeyOf(entry.key)

    // a re-set key must leave the tag sets it was in: read its old tags, then write atomically
    const previous = (yield* call(client.sMembers(companion) as Promise<string[]>)) ?? []
    const multi = client.multi()

    for (const tag of previous) {
      multi.sRem(tag, entry.key)
    }

    multi.unlink(companion)

    multi.set(
      entry.key,
      Buffer.from(entry.data),
      entry.ttlMs === null ? {} : { PX: Math.max(1, Math.trunc(entry.ttlMs)) },
    )

    if (entry.tags.length > 0) {
      multi.sAdd(companion, [...entry.tags])

      if (entry.ttlMs !== null) {
        multi.pExpire(companion, Math.max(1, Math.trunc(entry.ttlMs)))
      }

      for (const tag of entry.tags) {
        multi.sAdd(tag, entry.key)
      }
    }

    yield* call(multi.exec() as Promise<unknown>)
  },

  *del(keys) {
    const { client } = yield* useContext(StateRef)
    const removed = Number(yield* call(client.unlink(keys) as Promise<number>))
    yield* call(client.unlink(keys.map(tagsKeyOf)) as Promise<number>)

    return removed
  },

  *has(key) {
    const { client } = yield* useContext(StateRef)
    return Number(yield* call(client.exists(key) as Promise<number>)) > 0
  },

  *ttl(key) {
    const { client } = yield* useContext(StateRef)
    const ms = Number(yield* call(client.pTTL(key) as Promise<number>))

    // -2: no key, -1: no expiry
    return ms < 0 ? null : ms
  },

  *expire(key, ttlMs) {
    const { client } = yield* useContext(StateRef)

    const applied = yield* call(
      client.pExpire(key, Math.max(1, Math.trunc(ttlMs))) as Promise<AnyType>,
    )

    return Boolean(applied)
  },

  *incr(key, by, ttlMs) {
    const { client } = yield* useContext(StateRef)
    const next = Number(yield* call(client.incrBy(key, by) as Promise<number>))

    if (ttlMs !== null && next === by) {
      // the counter was created by this call: start its window
      yield* call(client.pExpire(key, Math.max(1, Math.trunc(ttlMs))) as Promise<unknown>)
    }

    return next
  },

  *keys(prefix, options) {
    const { client } = yield* useContext(StateRef)

    const reply = yield* call(
      client.scan(options.cursor ?? '0', {
        MATCH: `${globEscape(prefix)}*`,
        COUNT: options.limit,
      }) as Promise<AnyType>,
    )
    const keys = (reply.keys as string[]).filter(key => !key.endsWith(TAGS_SUFFIX)).toSorted()
    const cursor = String(reply.cursor)

    return { keys, cursor: cursor === '0' ? null : cursor }
  },

  *invalidate(tags) {
    const { client } = yield* useContext(StateRef)
    let removed = 0

    for (const tag of tags) {
      const members = (yield* call(client.sMembers(tag) as Promise<string[]>)) ?? []

      if (members.length > 0) {
        // memberships left behind in OTHER tag sets are harmless: UNLINK of a gone key counts 0
        removed += Number(yield* call(client.unlink(members) as Promise<number>))
        yield* call(client.unlink(members.map(tagsKeyOf)) as Promise<number>)
      }

      yield* call(client.unlink(tag) as Promise<number>)
    }

    return removed
  },

  *clear(prefix) {
    const { client } = yield* useContext(StateRef)
    let removed = 0
    let cursor = '0'

    do {
      const reply = yield* call(
        client.scan(cursor, { MATCH: `${globEscape(prefix)}*`, COUNT: 500 }) as Promise<AnyType>,
      )
      cursor = String(reply.cursor)
      const keys = reply.keys as string[]

      if (keys.length > 0) {
        const values = keys.filter(key => !key.endsWith(TAGS_SUFFIX))
        yield* call(client.unlink(keys) as Promise<number>)
        removed += values.length
      }
    } while (cursor !== '0')

    return removed
  },
}
