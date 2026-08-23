import type { KvDef } from 'db:core'
import { DEFAULT_KV_PREFIX, isValidKvPrefix, Kv, kvActions, kvDefaults, KvErrors } from 'db:core'
import { hasCodec } from 'std:codec'
import { attempt, ensure, until } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { RESP_TYPES } from 'redis'
import { JsonCodec } from 'std:codec/impl/json'

import { driver, StateRef } from './internal'
import type { RedisKvDef } from './types'
import { redisKvImpl } from './utils/context'

/**
 * The Redis Kv store over the official `redis` client (v6) — `install(RedisKv, { prefix,
 * url })`. Keys live under `<prefix>:`, TTLs are `PX`, tags are sets (`<prefix>:$tag:<tag>`)
 * written in the same `MULTI` as the value, counters are `INCRBY`, scans are `SCAN MATCH`. The
 * connection closes with the scope. `JsonCodec` is installed unless the scope has a codec.
 */
export const RedisKv: KvDef.Handle = Kv.implement<KvDef.Options, [options: RedisKvDef.Options]>({
  name: 'kv-redis',
  version: '0.1.0',
  description: 'Redis key/value store',

  *setup(options) {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }
    const prefix = options.prefix ?? DEFAULT_KV_PREFIX
    if (!isValidKvPrefix(prefix)) {
      return yield* fail(KvErrors.Configuration, `invalid kv prefix "${prefix}"`)
    }
    const impl = yield* redisKvImpl.expect()
    const client = impl.createClient({ ...options.client, url: options.url })
    // a client with no error listener throws on socket errors — keep them as failures instead
    client.on('error', () => {})
    const opened = yield* attempt(until(client.connect()))
    if (isFailure(opened)) {
      return yield* fail(
        KvErrors.Connection,
        `cannot connect to redis: ${String((opened.error as AnyType)?.message ?? opened.error)}`,
      )
    }
    const state: RedisKvDef.State = {
      client,
      bytes: client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }),
      closed: false,
    }
    yield* StateRef.set(state)
    yield* ensure(function* () {
      state.closed = true
      yield* attempt(until(client.quit()))
    })
    return { store: 'redis', prefix, capabilities: driver.capabilities }
  },
}).build({
  ...kvDefaults(),
  ...kvActions(driver),
})
