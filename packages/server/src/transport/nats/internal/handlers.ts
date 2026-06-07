import type { Service, TransportDef } from 'server:core'
import { Broker } from 'server:core'
import { Codec } from 'std:codec'
import { ensure, into, isStream, operation, spawn, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, fail, isSuccess, succeed } from 'std:result'

import type { Msg } from 'nats'

import type { Nats } from '../types'

import { useNatsContext } from './context'
import { invokeAction } from './invoke'
import { pumpToNats } from './pump'
import { cancelSubject } from './subjects'
import { captureInputStreams } from './subscribe'
import { encodeReply, wireFailure, wireStream, wireSuccess } from './wire'

export const handleEmit = operation(function* (msg: Msg) {
  const decoded = (yield* Codec.actions.decode(msg.data)) as TransportDef.EventRequest
  const broker = yield* useContext(Broker)

  broker.bus.emit('event.emit', decoded)
})

export const handleBroadcast = operation(function* (msg: Msg) {
  const decoded = (yield* Codec.actions.decode(msg.data)) as TransportDef.EventRequest
  const broker = yield* useContext(Broker)

  broker.bus.emit('event.broadcast', decoded)
})

export const handleDispatch = (service: Service, actionKey: string) =>
  operation(function* (msg: Msg) {
    let decoded: Result<unknown, unknown>
    try {
      decoded = succeed(yield* Codec.actions.decode(msg.data))
    } catch (error) {
      decoded = asFailure(error)
    }

    if (!isSuccess(decoded)) {
      if (msg.reply) {
        msg.respond(yield* encodeReply(wireFailure(decoded)))
      }
      return
    }

    const req = decoded.value as Nats.DispatchPayload

    const cid = req.cid
    const inputSubjects = req.inputSubjects ?? []
    const outputSubject = req.outputSubject

    const nats = yield* useNatsContext()
    const cancelSub = nats.connection.subscribe(cancelSubject(nats.prefix, cid))

    yield* ensure(function* () {
      if (!cancelSub.isClosed()) {
        cancelSub.unsubscribe()
      }
    })

    const handlerTask = yield* spawn(function* () {
      let responded = false

      const respond = function* (wire: Nats.Wire) {
        if (responded || !msg.reply) {
          return
        }
        responded = true
        try {
          msg.respond(yield* encodeReply(wire))
        } catch {
          /* connection may already be torn down */
        }
      }

      yield* ensure(function* () {
        yield* respond(wireFailure(asFailure(fail('cancelled', 'handler cancelled'))))
      })

      const { streams, subs } = yield* captureInputStreams(inputSubjects)

      const unsubscribeInputs = () => {
        for (const sub of subs) {
          if (!sub.isClosed()) {
            sub.unsubscribe()
          }
        }
      }

      let outcome: Result<unknown, unknown>
      try {
        outcome = succeed(
          yield* invokeAction({
            service,
            actionKey,
            params: req.params ?? [],
            streams,
            rawReq: req.rawReq,
            traceContext: req.traceContext,
          }),
        )
      } catch (error) {
        outcome = asFailure(error)
      }

      if (!isSuccess(outcome)) {
        unsubscribeInputs()
        yield* respond(wireFailure(outcome))
        return
      }

      if (outputSubject !== undefined && isStream(outcome.value)) {
        const output = outcome.value
        yield* respond(wireStream())
        try {
          yield* pumpToNats(nats.connection, outputSubject, output)
        } finally {
          unsubscribeInputs()
        }
        return
      }

      unsubscribeInputs()
      yield* respond(wireSuccess(outcome.value))
    })

    yield* spawn(function* () {
      const subscription = yield* into(cancelSub as AsyncIterable<Msg>)
      const next = yield* subscription.next()
      if (!next.done) {
        yield* handlerTask.halt()
      }
    })

    let completed = false
    try {
      try {
        yield* handlerTask
        completed = true
      } catch {
        /* swallow halt — logged below */
      }
    } finally {
      if (!completed && (yield* Logger.context.get()) !== undefined) {
        yield* Logger.actions.child({ service: service.name, action: actionKey }, function* () {
          yield* Logger.actions.warn(
            'nats:handler-cancelled',
            asFailure(fail('cancelled', 'handler cancelled')),
          )
        })
      }
    }
  })
