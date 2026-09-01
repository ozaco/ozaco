import { hasCodec } from 'std:codec'
import { ensure } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'
import type { TransportDef } from 'transport:core'
import { isValidPrefix, Transport, transportActions, TransportErrors } from 'transport:core'

import pkg from '../../../package.json'

import { driver, StateRef } from './internal'
import type { Memory } from './types'
import { createLink } from './utils'

/**
 * The in-process transport — the reference `Transport` implementation and the test double for
 * multi-node messaging: installs sharing one {@link Memory.Link} behave like nodes on a broker
 * (wildcard topics, competing-consumer groups, receipts, durable consumers that hold messages
 * until acked). No native request/reply (core emulates it). `JsonCodec` is installed unless the
 * scope has a codec.
 */
export const MemoryTransport = Transport.implement<TransportDef.Options, [options: Memory.Options]>(
  {
    name: 'transport-memory',
    version: pkg.version,
    description: 'In-process transport over a shared link',

    *setup(options) {
      if (!(yield* hasCodec())) {
        yield* install(JsonCodec)
      }

      if (!isValidPrefix(options.prefix)) {
        return yield* fail(TransportErrors.Configuration, `invalid prefix "${options.prefix}"`)
      }

      const link = options.link ?? createLink()
      const state: Memory.State = {
        link,
        prefix: options.prefix,
        maxPayloadBytes: options.maxPayloadBytes ?? null,
        status: 'connected',
        outbox: [],
        watchers: new Set(),
      }

      link.states.add(state)
      yield* ensure(() => {
        link.states.delete(state)
      })
      yield* StateRef.set(state)

      return {
        transport: 'memory',
        prefix: options.prefix,
        // the limit is per install, not per driver — report what this one actually enforces
        capabilities: { ...driver.capabilities, maxPayloadBytes: state.maxPayloadBytes },
      }
    },
  },
).build(transportActions(driver))
