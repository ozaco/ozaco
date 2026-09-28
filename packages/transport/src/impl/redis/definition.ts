import { Codec } from 'std:codec'
import { attempt, ensure, until } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'
import type { TransportDef } from 'transport:core'
import {
  isValidPrefix,
  Transport,
  transportActions,
  TransportErrors,
  watchStatus,
} from 'transport:core'

import pkg from '../../../package.json'

import { driver, StateRef } from './internal'
import type { Redis } from './types'
import { redisImpl } from './utils'

/**
 * Redis transport over the official `redis` client (v6, RESP3) — `RedisTransport.use({ prefix, url })`.
 * Pub/sub for data/event/flow/stream (channels `<prefix>.<topic>`, headers framed into the
 * payload), Redis Streams for competing-consumer groups and durables (`subscribe({ group |
 * durable })` / `serve({ group })` — literal topics only; durables ack explicitly and reclaim
 * what dead members left pending), `PUBLISH` receipts give instant `no-responders`. Two
 * connections: commands + a subscriber. `JsonCodec` is installed unless the scope has a codec.
 */
export const RedisTransport = Transport.implement<TransportDef.Options, [options: Redis.Options]>({
  name: 'transport-redis',
  version: pkg.version,
  description: 'Redis transport over pub/sub + Streams',

  *setup(options) {
    if (!(yield* Codec.actions.hasCodec())) {
      yield* JsonCodec.use()
    }

    if (!isValidPrefix(options.prefix)) {
      return yield* fail(TransportErrors.Configuration, `invalid prefix "${options.prefix}"`)
    }

    const impl = yield* redisImpl.expect()
    const client = impl.createClient({ ...options.client, url: options.url })
    const subscriber = client.duplicate()
    // a client with no error listener throws on socket errors — keep them as status instead; the
    // latest one (folded) names the cause when the connection-lost line is logged
    const seen: { error?: Result.Failure<unknown> } = {}
    const onError = (error: unknown) => {
      seen.error = asFailure(error)
    }

    client.on('error', onError)
    subscriber.on('error', onError)

    const opened = yield* attempt(until(Promise.all([client.connect(), subscriber.connect()])))

    if (isFailure(opened)) {
      return yield* fail(
        TransportErrors.Connection,
        'cannot connect to redis',
        asFailure(opened, TransportErrors),
      )
    }

    const state: Redis.State = {
      client,
      subscriber,
      prefix: options.prefix,
      streamMaxLen: options.streamMaxLen ?? 10_000,
      ackWaitMs: options.ackWaitMs ?? 30_000,
      status: 'connected',
      drained: false,
    }

    yield* StateRef.set(state)

    yield* ensure(function* () {
      if (!state.drained) {
        state.drained = true
        yield* attempt(until(subscriber.quit()))
        yield* attempt(until(client.quit()))
      }
    })

    // connection lost / back / closed → the Logger, while the install lives
    yield* watchStatus(driver.status(), {
      transport: 'redis',
      prefix: options.prefix,
      detail: () => (seen.error === undefined ? undefined : { error: seen.error }),
    })

    return { transport: 'redis', prefix: options.prefix, capabilities: driver.capabilities }
  },
}).build(transportActions(driver))
