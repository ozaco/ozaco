import { Kv, KvErrors } from 'db:core'
import { run } from 'std:effect'
import { formatFailure, isFailure, ResultErrors } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { RedisKv, redisKvImpl } from 'db:impl/redis-kv'

import { runKvSuite } from './suite'

/** Set TRANSPORT_TEST_REDIS_URL (e.g. redis://127.0.0.1:6379) to run these against a live server
 * — `moon run db:test-redis` spins a disposable container. */
const url = process.env.TRANSPORT_TEST_REDIS_URL

runKvSuite({
  label: 'redis',
  enabled: Boolean(url),
  use: (prefix = 'suite') => RedisKv.use({ prefix, url: url! }),
  expect: { persistent: true, atomic: true },
})

/** A client whose `connect` / `get` reject with `connectError` / `getError`. */
const fakeClient = (connectError?: Error, getError?: Error) => {
  const fake = {
    on() {},
    connect: () => (connectError ? Promise.reject(connectError) : Promise.resolve()),
    quit: async () => {},
    get: () => Promise.reject(getError),
    withTypeMapping() {
      return fake
    },
  }

  return fake as AnyType
}

// a `kv.connection` failure carries the client's rejection one level under it: the runtime's
// `std:result.unknown` fold of it, the client error itself the fold's `raw`, its text in the chain
describe('redis — client rejections (fake client)', () => {
  it('a failed connect: kv.connection over the fold of the client error', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    })
    const outcome = (await run(function* () {
      yield* redisKvImpl.set({ createClient: () => fakeClient(refused) })
      yield* RedisKv.use({ prefix: 'x', url: 'redis://127.0.0.1:6379' })
    })) as AnyType

    expect(isFailure(outcome)).toBe(true)
    expect(outcome.error).toBe(KvErrors.Connection)
    expect(outcome.message).toBe('cannot connect to redis')
    const nested = outcome.causes.filter(isFailure)
    expect(nested).toHaveLength(1)
    expect(nested[0].error).toBe(ResultErrors.Unknown)
    expect(nested[0].raw).toBe(refused)
    expect(formatFailure(outcome, { chain: true })).toContain('connect ECONNREFUSED 127.0.0.1:6379')
  })

  it('a failed command: kv.connection over the fold of the client error', async () => {
    const reset = Object.assign(new Error('Socket closed unexpectedly'), { code: 'ECONNRESET' })
    const outcome = (await run(function* () {
      yield* redisKvImpl.set({ createClient: () => fakeClient(undefined, reset) })
      yield* RedisKv.use({ prefix: 'x', url: 'redis://127.0.0.1:6379' })
      yield* Kv.actions.get('key')
    })) as AnyType

    expect(isFailure(outcome)).toBe(true)
    expect(outcome.error).toBe(KvErrors.Connection)
    expect(outcome.message).toBe('redis command failed')
    const nested = outcome.causes.filter(isFailure)
    expect(nested).toHaveLength(1)
    expect(nested[0].error).toBe(ResultErrors.Unknown)
    expect(nested[0].raw).toBe(reset)
    expect(formatFailure(outcome, { chain: true })).toContain('Socket closed unexpectedly')
  })
})
