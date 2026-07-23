import type { TransportDef } from 'server:core'
import { Transport } from 'server:core'
import { Codec } from 'std:codec'
import type { Stream } from 'std:effect'
import { ensure, map, mapError, operation, until, useScope } from 'std:effect'
import { fail } from 'std:result'

import { connect } from 'nats'
import { JsonCodec } from 'std:codec/impl/json'

import { EMPTY_PAYLOAD } from './const'
import { brokerWathcer } from './internal/broker-watcher'
import { consume } from './internal/consume'
import { getSelf, useNatsContext } from './internal/context'
import { mapNatsFailure } from './internal/error-map'
import { handleBroadcast, handleEmit } from './internal/handlers'
import { pumpInputStreams } from './internal/pump'
import {
  broadcastSubject,
  broadcastWildcard,
  cancelSubject,
  dispatchSubject,
  emitGroupSubject,
  emitSubject,
  emitWildcard,
  streamInputSubject,
  streamOutputSubject,
} from './internal/subjects'
import { subscribeFromNats } from './internal/subscribe'
import { unwrapWire } from './internal/wire'
import type { Nats } from './types'

const generateSid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

// NATS core request/reply needs a finite timer; `requestTimeoutMs <= 0` (timeout disabled) maps to the
// largest value `setTimeout` accepts (~24.8 days), so in practice the action TimeoutPolicy always
// fires first — but a NATS connection/responder fault still can't hang the dispatch forever.
const MAX_REQUEST_TIMEOUT = 2_147_483_647

export const NatsTransport = Transport.implement({
  name: 'server/nats-transport',
  version: '0.0.0',

  *setup(options: Nats.Options = {}) {
    const name = options.name ?? 'nats'
    const priority = options.priority ?? 10
    const next = options.next ?? (() => false)
    const prefix = options.subjectPrefix ?? 'ozaco'
    const requestTimeoutMs = options.requestTimeoutMs ?? 1000 * 30

    const scope = yield* useScope()

    const connection = yield* mapError(
      until(
        connect({
          servers: options.servers ?? 'nats://localhost:4222',
          reconnect: true,
        }),
        'nats:connect',
      ),
      mapNatsFailure,
    )

    const subscriptions: Nats.Context['subscriptions'] = new Map()

    const emitSub = connection.subscribe(emitWildcard(prefix))
    subscriptions.set(emitWildcard(prefix), emitSub)

    const broadcastSub = connection.subscribe(broadcastWildcard(prefix))
    subscriptions.set(broadcastWildcard(prefix), broadcastSub)

    yield* consume(emitSub, handleEmit)
    yield* consume(broadcastSub, handleBroadcast)

    yield* brokerWathcer()
    yield* ensure(function* () {
      yield* map([...subscriptions.entries()], function* ([, sub]) {
        sub.unsubscribe()
        yield* until(sub.drain())
      })

      subscriptions.clear()

      yield* Transport.actions.unregister(getSelf())
      yield* until(connection.close(), 'nats:unconnect')
    })

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

    yield* Transport.actions.register(getSelf(), context)

    return context
  },
}).build({
  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const nats = yield* useNatsContext()

    const subject = dispatchSubject(nats.prefix, req.serviceName, req.actionKey)
    const hasStreams = req.streams !== undefined

    const cid = generateSid()
    const inputSubjects = hasStreams
      ? (req.streams ?? []).map((_, i) => streamInputSubject(nats.prefix, cid, i))
      : undefined
    const outputSubject = hasStreams ? streamOutputSubject(nats.prefix, cid) : undefined

    yield* ensure(function* () {
      nats.connection.publish(cancelSubject(nats.prefix, cid), EMPTY_PAYLOAD)
    })

    const payload: Nats.DispatchPayload = {
      cid,
      serviceName: req.serviceName,
      actionKey: req.actionKey,
      ...(req.params === undefined ? {} : { params: req.params }),
      ...(inputSubjects === undefined ? {} : { inputSubjects }),
      ...(outputSubject === undefined ? {} : { outputSubject }),
      ...(req.contexts === undefined ? {} : { contexts: req.contexts }),
    }

    const startPayload = yield* Codec.actions.encode(payload)

    const requestTimeout = nats.requestTimeoutMs <= 0 ? MAX_REQUEST_TIMEOUT : nats.requestTimeoutMs

    const reply = yield* mapError(
      until(
        nats.connection.request(subject, startPayload, { timeout: requestTimeout }),
        `nats:request ${subject}`,
      ),
      mapNatsFailure,
    )

    const wire = (yield* JsonCodec.actions.decode(reply.data)) as Nats.Wire

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
        pumpInputStreams(nats, inputSubjects, (req.streams ?? []) as Stream<unknown, never>[])
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
