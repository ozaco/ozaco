import { hasCodec } from 'std:codec'
import { ensure } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'
import type { TransportDef } from 'transport:core'
import {
  isValidPrefix,
  Transport,
  transportActions,
  transportDefaults,
  TransportErrors,
} from 'transport:core'

import pkg from '../../../package.json'

import { attached, deliver, driver, isFrame, StateRef } from './internal'
import type { Worker } from './types'

/**
 * The worker-thread transport — one channel between a main thread and a worker (or any two
 * `MessagePort` ends): `install(WorkerTransport, { prefix, port: worker })` on one side,
 * `install(WorkerTransport, { prefix, port: self })` on the other. Every publish reaches both
 * ends' subscribers (structured clone, at-most-once, no groups/durables/receipts — request/reply
 * is core's emulation, so a missing responder surfaces as `transport.timeout`). `JsonCodec` is
 * installed unless the scope has a codec.
 */
export const WorkerTransport: TransportDef.Handle = Transport.implement<
  TransportDef.Options,
  [options: Worker.Options]
>({
  name: 'transport-worker',
  version: pkg.version,
  description: 'Worker-thread transport over postMessage',

  *setup(options) {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }
    if (!isValidPrefix(options.prefix)) {
      return yield* fail(TransportErrors.Configuration, `invalid prefix "${options.prefix}"`)
    }

    const state: Worker.State = {
      port: options.port,
      prefix: options.prefix,
      subscribers: new Set(),
      status: 'connected',
    }

    const onMessage = (event: { data: unknown }) => {
      if (isFrame(event.data)) {
        deliver(state, event.data)
      }
    }

    options.port.addEventListener('message', onMessage)

    const peers = attached.get(options.port) ?? new Set<Worker.State>()
    peers.add(state)
    attached.set(options.port, peers)

    yield* ensure(() => {
      options.port.removeEventListener('message', onMessage)
      peers.delete(state)
      state.status = 'closed'
    })

    yield* StateRef.set(state)
    return { transport: 'worker', prefix: options.prefix, capabilities: driver.capabilities }
  },
}).build({
  ...transportDefaults(),
  ...transportActions(driver),
})
