import { attempt, run } from 'std:effect'
import type { Result } from 'std:result'
import { isFailure, ResultErrors, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'
import { RedisTransport, redisImpl } from 'transport:impl/redis'

import { runTransportSuite } from './suite'

/** Set TRANSPORT_TEST_REDIS_URL (e.g. redis://127.0.0.1:6379) to run these against a live server
 * — `moon run transport:test-redis` spins a disposable container. */
const url = process.env.TRANSPORT_TEST_REDIS_URL

runTransportSuite({
  label: 'redis',
  enabled: Boolean(url),
  use: (prefix = 'suite') => RedisTransport.use({ prefix, url: url!, ackWaitMs: 1000 }),
  expect: { receipts: true, requestReply: false, groups: true, durable: true },
  ackWaitMs: 1000,
})

/** A fake `redis` client for `redisImpl.createClient` (its duplicate is itself): `connect` and
 * `multi().….exec()` settle as given. */
const fakeRedis = (connect: () => Promise<void>, exec: () => Promise<unknown>) => {
  const chain = {
    publish: () => chain,
    sCard: () => chain,
    exec,
  }
  const client = {
    connect,
    duplicate: () => client,
    on: () => client,
    off: () => client,
    quit: async () => {},
    multi: () => chain,
  }

  return { createClient: () => client }
}

/** `outcome` as the failure it must be. */
const failureOf = (outcome: unknown): Result.Failure<unknown> => {
  expect(isFailure(outcome)).toBe(true)
  return outcome as Result.Failure<unknown>
}

/** The failures `failure` nests, in order. */
const nestedOf = (failure: Result.Failure<unknown>): Result.Failure<unknown>[] =>
  failure.causes.filter(cause => typeof cause !== 'string')

describe('transport — redis: client errors (fake client)', () => {
  it('a refused dial is transport.connection over the fold of the client error', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    })

    const { outcome } = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* redisImpl.set(
          fakeRedis(
            () => Promise.reject(refused),
            () => Promise.resolve([0, 0]),
          ),
        )
        return {
          outcome: yield* attempt(RedisTransport.use({ prefix: 'dial', url: 'redis://x:1' })),
        }
      }),
    )
    const failure = failureOf(outcome)

    expect(failure.error).toBe(TransportErrors.Connection)
    expect(failure.message).toBe('cannot connect to redis')
    // one level under it: the fold of the client error, the Error itself its `raw`
    expect(nestedOf(failure).map(cause => cause.error)).toEqual([ResultErrors.Unknown])
    expect(nestedOf(failure)[0]?.message).toBe(
      'Error: connect ECONNREFUSED 127.0.0.1:6379 (ECONNREFUSED)',
    )
    expect(nestedOf(failure)[0]?.raw).toBe(refused)
  })

  it('a command the client rejects is transport.connection naming the command, over the fold', async () => {
    const lost = new Error('Socket closed unexpectedly')

    const { outcome } = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* redisImpl.set(
          fakeRedis(
            () => Promise.resolve(),
            () => Promise.reject(lost),
          ),
        )
        yield* RedisTransport.use({ prefix: 'cmd', url: 'redis://x:1' })
        return { outcome: yield* attempt(Transport.actions.publish('some.topic', 'hello')) }
      }),
    )
    const failure = failureOf(outcome)

    expect(failure.error).toBe(TransportErrors.Connection)
    expect(failure.message).toBe('cannot publish on "some.topic"')
    expect(nestedOf(failure).map(cause => cause.error)).toEqual([ResultErrors.Unknown])
    expect(nestedOf(failure)[0]?.message).toBe('Error: Socket closed unexpectedly')
    expect(nestedOf(failure)[0]?.raw).toBe(lost)
  })
})
