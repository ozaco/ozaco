import type { TransportDef } from 'server:core'
import { Codec, Transport, registerTransport, unregisterTransport } from 'server:core'
import type { Stream } from 'std:effect'
import { ensure, map, mapError, operation, until, useScope } from 'std:effect'
import { fail } from 'std:result'

import { connect } from 'nats'

import { getSelf, mapNatsFailure, useNatsContext } from './internal'
import { brokerWathcer } from './internal/broker-watcher'
import { consume } from './internal/consume'
import { handleBroadcast, handleEmit } from './internal/handlers'
import { pumpToNats, subscribeFromNats } from './internal/stream'
import {
  broadcastSubject,
  broadcastWildcard,
  dispatchSubject,
  emitGroupSubject,
  emitSubject,
  emitWildcard,
  streamInputSubject,
  streamOutputSubject,
} from './internal/subjects'
import { unwrapWire } from './internal/wire'
import type { Nats } from './types'

const generateSid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const NatsTransport = Transport.implement({
  name: 'server/nats-transport',
  version: '0.0.0',

  *setup(options: Nats.Options = {}) {
    const name = options.name ?? 'nats'
    const priority = options.priority ?? 10
    const next = options.next ?? (() => false)
    const prefix = options.subjectPrefix ?? 'ozaco'
    const requestTimeoutMs = options.requestTimeoutMs ?? 5000

    yield* brokerWathcer()

    const scope = yield* useScope()

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
      scope,
    }

    yield* registerTransport(getSelf(), context)

    yield* ensure(function* () {
      yield* map([...subscriptions.entries()], function* ([, sub]) {
        yield* until(sub.drain())

        yield* ensure(function* () {
          sub.unsubscribe()
        })
      })

      subscriptions.clear()

      yield* unregisterTransport(getSelf())
      yield* until(connection.close(), 'nats:unconnect')
    })

    return context
  },
}).build({
  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const nats = yield* useNatsContext()

    const subject = dispatchSubject(nats.prefix, req.serviceName, req.actionKey)
    const hasStreams = req.streams !== undefined

    const sid = hasStreams ? generateSid() : ''
    const inputSubjects = hasStreams
      ? (req.streams ?? []).map((_, i) => streamInputSubject(nats.prefix, sid, i))
      : undefined
    const outputSubject = hasStreams ? streamOutputSubject(nats.prefix, sid) : undefined

    const payload: Nats.DispatchPayload = {
      serviceName: req.serviceName,
      actionKey: req.actionKey,
      ...(req.params === undefined ? {} : { params: req.params }),
      ...(inputSubjects === undefined ? {} : { inputSubjects }),
      ...(outputSubject === undefined ? {} : { outputSubject }),
      ...(req.rawReq === undefined ? {} : { rawReq: req.rawReq }),
      ...(req.traceContext === undefined ? {} : { traceContext: req.traceContext }),
    }

    const startPayload = yield* Codec.actions.encode(payload)

    const reply = yield* mapError(
      until(
        nats.connection.request(subject, startPayload, { timeout: nats.requestTimeoutMs }),
        `nats:request ${subject}`,
      ),
      mapNatsFailure,
    )

    const wire = (yield* Codec.actions.decode(reply.data)) as Nats.Wire

    if (wire._t === '__failure__') {
      return yield* unwrapWire(wire)
    }

    if (wire._t === '__stream__') {
      if (outputSubject === undefined) {
        return yield* fail(
          'server:core.transport-dispatch',
          'received stream reply but no output subject was set up',
        )
      }

      const outSub = nats.connection.subscribe(outputSubject)
      const outputStream = yield* subscribeFromNats(outSub, nats.scope)

      if (inputSubjects !== undefined) {
        const streams = (req.streams ?? []) as Stream<unknown, never>[]
        for (let i = 0; i < streams.length; i++) {
          const stream = streams[i]!
          const subjectName = inputSubjects[i]!

          nats.scope.run(function* () {
            try {
              yield* pumpToNats(nats.connection, subjectName, stream)
            } catch {
              /* input pump errors swallowed — receiver sees end/error */
            }
          })
        }
      }

      return outputStream
    }

    return wire.value
  }),

  emit: operation(function* (req: TransportDef.EventRequest) {
    const nats = yield* useNatsContext()
    const payload = yield* Codec.actions.encode(req)

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
    const payload = yield* Codec.actions.encode(req)

    nats.connection.publish(broadcastSubject(nats.prefix, req.name), payload)
  }),
})
