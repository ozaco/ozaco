import type { Operation } from 'std:effect'
import { attempt, fork, useContext } from 'std:effect'
import { createEvent } from 'std:event'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import { Transport } from 'transport:core'

import pkg from '../../../package.json'
import { DEFAULT_BUS_TOPIC } from '../const'
import { DbErrors } from '../errors'
import type { Bus } from '../types/bus'

const DbBusImpl = definePlugin<Bus.Context, [options?: Bus.Options]>({
  name: 'db-bus',
  version: pkg.version,
  description: 'Cross-node change bus over an @ozaco/transport plugin',

  *setup(options) {
    const topic = options?.topic ?? DEFAULT_BUS_TOPIC
    // pinned to the given transport, or routed to the most recently installed one
    const transport = (options?.transport ?? Transport) as Bus.Context['transport']
    const described = yield* attempt(() => useContext(transport))
    if (isFailure(described)) {
      return yield* fail(
        DbErrors.Configuration,
        'the bus needs a transport: install one (MemoryTransport, NatsTransport, …) before DbBus',
        ...described.causes,
      )
    }

    const events = createEvent<Bus.Events>()
    // the inbound pump lives with the install scope: every envelope a peer ships on the topic
    // is emitted as-is (the client drops its own echoes by origin)
    const subscription = yield* transport.actions.subscribe<Bus.Envelope>(topic)

    yield* fork(function* () {
      for (;;) {
        const step = yield* subscription.next()
        if (step.done) {
          return
        }
        events.emit('change', step.value.value)
      }
    })

    return { transport, transportName: described.value.transport, topic, events }
  },
})

/**
 * The cross-node change bus — ONE plugin for every network: `install(DbBus, { transport })`
 * after installing a transport, and every committed write of this node travels to its peers as an
 * envelope on the transport's data plane (`<prefix>.db.change`), while the peers' envelopes feed
 * this node's watchers. No durability is asked of the transport: a lost envelope is a sequence
 * gap, and the change log replays it. Install before `DbClient` (bridged at install) or after it
 * and call `Db.actions.bridge()`.
 */
export const DbBus = DbBusImpl.build<Bus.Actions>({
  *publish(envelope: Bus.Envelope): Operation<void> {
    const { transport, topic } = yield* DbBusImpl.context.expect()
    yield* transport.actions.publish(topic, envelope)
  },
})
