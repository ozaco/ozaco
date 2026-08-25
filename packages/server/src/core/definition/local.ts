import type { Operation } from 'std:effect'
import { createSignal, useContext } from 'std:effect'
import { useBufferedEvent } from 'std:event'
import { fail } from 'std:result'

import pkg from '../../../package.json'
import { ServerErrors } from '../errors'
import { LocalCarrierRef } from '../internal/context'
import type { CarrierDef } from '../types/carrier'
import type { WireDef } from '../types/wire'
import { carrierDefaults } from '../utils/defaults'

import { Carrier, Server } from './protocol'

/**
 * The single-process carrier: knows only the services served on this node. `send` to anything
 * else fails `server.unavailable` — the honest answer without a network. Events fan out on the
 * kernel's own event stream. `createServer` installs it when no carrier is given.
 */
export const LocalCarrier: CarrierDef.Handle = Carrier.implement<CarrierDef.Options, []>({
  name: 'server-carrier-local',
  version: pkg.version,
  description: 'In-process carrier',

  *setup() {
    yield* LocalCarrierRef.set({ served: new Map() })
    return { carrier: 'local', transport: 'local' }
  },
}).build({
  ...carrierDefaults(),

  *hosts(service) {
    return (yield* useContext(LocalCarrierRef)).served.has(service)
  },

  *members(service) {
    const state = yield* useContext(LocalCarrierRef)
    if (!state.served.has(service)) {
      return []
    }
    const kernel = yield* Server.context.expect()
    return [
      {
        instance: kernel.instance,
        serviceId: kernel.serviceId,
        version: kernel.registry.services.get(service)?.version ?? kernel.version,
        seenAt: Date.now(),
        draining: false,
      },
    ]
  },

  *send(dispatch, inputs) {
    const state = yield* useContext(LocalCarrierRef)
    const server = state.served.get(dispatch.service)
    if (!server) {
      return yield* fail(
        ServerErrors.Unavailable,
        `service "${dispatch.service}" is not hosted here and no network carrier is installed`,
      )
    }
    const lanes = new Map(inputs.map(lane => [lane.name, lane.source]))
    const served = yield* server(dispatch, function* (name) {
      const source = lanes.get(name)
      if (!source) {
        return yield* fail(ServerErrors.BadRequest, `no input stream "${name}"`)
      }
      return source
    })
    const outputs = new Map(served.outputs.map(lane => [lane.name, lane]))
    return {
      reply: {
        k: 'reply',
        cid: dispatch.cid,
        value: served.value,
        outputs: served.outputs.map(lane => ({ name: lane.name, brand: lane.brand })),
      },
      *lane(name) {
        const output = outputs.get(name)
        if (!output) {
          return yield* fail(ServerErrors.Internal, `no output stream "${name}"`)
        }
        return yield* output.open()
      },
    }
  },

  *serve(service, server) {
    ;(yield* useContext(LocalCarrierRef)).served.set(service, server)
  },

  *unserve(service) {
    ;(yield* useContext(LocalCarrierRef)).served.delete(service)
  },

  *leave() {},

  *emit(event) {
    const kernel = yield* Server.context.expect()
    kernel.events.emit('event', event.name, event.payload, event.trace)
  },

  events: () => ({
    *[Symbol.iterator]() {
      const kernel = yield* Server.context.expect()
      const subscription = yield* useBufferedEvent(kernel.events, 'event')
      return {
        *next(): Operation<IteratorResult<WireDef.Event, never>> {
          for (;;) {
            const step = yield* subscription.next()
            if (step.done) {
              continue
            }
            const [name, payload, trace] = step.value
            return {
              done: false,
              value: { k: 'event', name, payload, origin: kernel.serviceId, trace },
            }
          }
        },
      }
    },
  }),

  *cancel() {},

  status: () => ({
    *[Symbol.iterator]() {
      const signal = createSignal<'connected' | 'reconnecting' | 'closed', void>()
      const subscription = yield* signal
      signal.send('connected')
      return subscription
    },
  }),
})
