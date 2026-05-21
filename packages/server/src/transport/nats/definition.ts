import type { TransportDef } from 'server:core'
import { Transport, registerTransport, unregisterTransport } from 'server:core'
import { ensure, operation, until } from 'std:effect'

import { connect } from 'nats'

import { getSelf, useNatsContext } from './internal'
import type { Nats } from './types'
import { brokerWathcer } from './utils/broker-watcher'
import { consume } from './utils/consume'
import { handleBroadcast, handleEmit } from './utils/handle-event'
import {
  broadcastSubject,
  broadcastWildcard,
  dispatchSubject,
  emitGroupSubject,
  emitSubject,
  emitWildcard,
} from './utils/subjects'
import { decodeMessage, encodeMessage, unwrapWire } from './utils/wire'

export const NatsTransport = Transport.implement({
  name: 'server/nats-transport',
  version: '0.0.0',

  *setup(options: Nats.Options = {}) {
    const name = options.name ?? 'nats'
    const priority = options.priority ?? 10
    const next = options.next ?? false
    const prefix = options.subjectPrefix ?? 'ozaco'
    const requestTimeoutMs = options.requestTimeoutMs ?? 5000

    yield* brokerWathcer()

    const connection = yield* until(
      connect({
        servers: options.servers ?? 'nats://localhost:4222',
        reconnect: true,
      }),
      'nats:connect',
    )

    const subscriptions: Nats.Context['subscriptions'] = new Map()

    const emitSub = connection.subscribe(emitWildcard(prefix))
    subscriptions.set(emitWildcard(prefix), emitSub)

    const broadcastSub = connection.subscribe(broadcastWildcard(prefix))
    subscriptions.set(broadcastWildcard(prefix), broadcastSub)

    yield* consume(emitSub, handleEmit)
    yield* consume(broadcastSub, handleBroadcast)

    const context: Nats.Context = {
      name,
      priority,
      next,
      prefix,
      requestTimeoutMs,

      ...(options.queueGroup === undefined ? {} : { queueGroup: options.queueGroup }),

      subscriptions,
      connection,
    }

    yield* registerTransport(getSelf(), context)

    yield* ensure(function* () {
      yield* unregisterTransport(getSelf())
      yield* until(connection.close(), 'nats:unconnect')
      subscriptions.clear()
    })

    return context
  },
}).build({
  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const nats = yield* useNatsContext()

    const subject = dispatchSubject(nats.prefix, req.serviceName, req.actionKey)
    const payload = yield* encodeMessage(req)

    const reply = yield* until(
      nats.connection.request(subject, payload, { timeout: nats.requestTimeoutMs }),
      `nats:request ${subject}`,
    )

    const wire = (yield* decodeMessage(reply.data)) as Nats.Wire

    return yield* unwrapWire(wire)
  }),

  emit: operation(function* (req: TransportDef.EventRequest) {
    const nats = yield* useNatsContext()
    const payload = yield* encodeMessage(req)

    if (req.groups && req.groups.length > 0) {
      for (const group of req.groups) {
        nats.connection.publish(emitGroupSubject(nats.prefix, group, req.name), payload)
      }
      return
    }

    nats.connection.publish(emitSubject(nats.prefix, req.name), payload)
  }),

  broadcast: operation(function* (req: TransportDef.EventRequest) {
    const nats = yield* useNatsContext()
    const payload = yield* encodeMessage(req)

    nats.connection.publish(broadcastSubject(nats.prefix, req.name), payload)
  }),
})
