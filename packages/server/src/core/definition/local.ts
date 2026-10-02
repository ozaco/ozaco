import type { Operation } from 'std:effect'
import { createQueue, createSignal, ensure, useContext } from 'std:effect'
import { fail } from 'std:result'

import pkg from '../../../package.json'
import { ServerErrors } from '../errors'
import { LocalCarrierRef } from '../internal/context'
import type { CarrierDef } from '../types/carrier'
import type { WireDef } from '../types/wire'

import { Carrier, Server } from './protocol'

/**
 * The single-process carrier: knows only the services served on this node. `send` to anything
 * else fails `server.unavailable` — the honest answer without a network. Events fan out on the
 * kernel's own event stream. `createServer` installs it when no carrier is given.
 */
export const LocalCarrier = Carrier.implement<CarrierDef.Options, []>({
  name: 'server-carrier-local',
  version: pkg.version,
  description: 'In-process carrier',

  *setup() {
    yield* LocalCarrierRef.set({ served: new Map() })

    return { carrier: 'local', transport: 'local' }
  },
}).build({
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
        ...(served.http ? { http: served.http } : {}),
        ...(served.traceparent ? { traceparent: served.traceparent } : {}),
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

    kernel.events.emit('event', event)
  },

  /** The node's emits as they happen, from the kernel's event stream. The flow ENDS with the
   * scope that subscribed (its listener is gone): a `next()` pulled after that answers `done` at
   * once — never a wait on a queue nothing feeds any more, never a spin. */
  events: () => ({
    *[Symbol.iterator]() {
      const kernel = yield* Server.context.expect()
      const queue = createQueue<WireDef.Event, never>()
      const listener = (event: WireDef.Event) => {
        queue.add({ ...event, origin: kernel.serviceId })
      }
      let ended = false

      kernel.events.on('event', listener)

      yield* ensure(() => {
        kernel.events.off('event', listener)
        queue.close(undefined as never)
      })

      return {
        *next(): Operation<IteratorResult<WireDef.Event, never>> {
          if (ended) {
            return { done: true, value: undefined as never }
          }

          const step = yield* queue.next()

          ended = step.done === true

          return step
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
