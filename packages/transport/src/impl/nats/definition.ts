import { hasCodec } from 'std:codec'
import { attempt, ensure, until } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { JsonCodec } from 'std:codec/impl/json'
import type { TransportDef } from 'transport:core'
import { isValidPrefix, Transport, transportActions, TransportErrors } from 'transport:core'

import pkg from '../../../package.json'

import { driver, ensureStream, StateRef, streamNameOf, streamSpecOf } from './internal'
import type { Nats } from './types'
import { natsImpl } from './utils'

/**
 * NATS transport over `@nats-io` v3 — `install(NatsTransport, { prefix, servers })`. JetStream
 * by default: the install provisions ONE stream per application prefix (`<PREFIX>`, subjects
 * `<prefix>.>`, create-or-update) and every publish lands in it; plain subscriptions are ordered
 * ephemeral consumers from "now", groups share a named consumer, durables are durable consumers
 * with explicit acks. Only request/reply stays on core NATS (`_rpc.<prefix>.>`, never stored):
 * native `nc.request`, queue groups, `no-responders` from the server. The connection closes
 * with the scope; `drain()` flushes first. `JsonCodec` is installed unless the scope has a codec.
 */
export const NatsTransport = Transport.implement<TransportDef.Options, [options: Nats.Options]>({
  name: 'transport-nats',
  version: pkg.version,
  description: 'NATS transport over @nats-io JetStream (one stream per application prefix)',

  *setup(options) {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }
    if (!isValidPrefix(options.prefix)) {
      return yield* fail(TransportErrors.Configuration, `invalid prefix "${options.prefix}"`)
    }

    const impl = yield* natsImpl.expect()
    const servers = options.servers ?? options.connection?.servers

    const opened = yield* attempt(
      until(impl.connect({ ...options.connection, servers: servers as AnyType })),
    )

    if (isFailure(opened)) {
      return yield* fail(
        TransportErrors.Connection,
        `cannot connect to nats: ${String((opened.error as AnyType)?.message ?? opened.error)}`,
      )
    }

    const nc = opened.value
    const manager = yield* attempt(until(jetstreamManager(nc)))

    if (isFailure(manager)) {
      yield* attempt(until(nc.close()))
      return yield* fail(
        TransportErrors.Configuration,
        `jetstream is not available on this server: ${String((manager.error as AnyType)?.message ?? manager.error)}`,
      )
    }

    const state: Nats.State = {
      nc,
      js: jetstream(nc),
      jsm: manager.value,
      prefix: options.prefix,
      stream: streamNameOf(options.prefix),
      ackWaitMs: options.ackWaitMs ?? 30_000,
      maxDeliver: options.maxDeliver ?? 10,
      inactiveThresholdMs: options.inactiveThresholdMs ?? 60_000,
      drained: false,
    }

    yield* StateRef.set(state)
    // drain on teardown (flushes buffered publishes, then closes) — a bare close() could drop
    // the last publishes of a short-lived scope
    yield* ensure(function* () {
      if (!state.drained && !state.nc.isClosed()) {
        yield* attempt(until(state.nc.drain()))
      }
      yield* attempt(until(state.nc.close()))
    })

    yield* ensureStream(
      state,
      streamSpecOf({
        prefix: options.prefix,
        storage: options.storage ?? 'file',
        maxAgeMs: options.maxAgeMs ?? 24 * 60 * 60 * 1000,
        maxBytes: options.maxBytes,
        maxMsgs: options.maxMsgs,
        replicas: options.replicas ?? 1,
      }),
    )

    return {
      transport: 'nats',
      prefix: options.prefix,
      capabilities: { ...driver.capabilities, maxPayloadBytes: state.nc.info?.max_payload ?? null },
    }
  },
}).build(transportActions(driver))
