import type { Service, TransportDef } from 'server:core'
import { Broker, isStreamResult } from 'server:core'
import { attempt, ensure, into, operation, spawn, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, fail, isSuccess } from 'std:result'

import type { Msg } from 'nats'
import { JsonCodec } from 'std:codec/impl/json'

import { invokeAction } from '../../shared/invoke'
import type { Nats } from '../types'

import { useNatsContext } from './context'
import { pumpToNats } from './pump'
import { cancelSubject } from './subjects'
import { captureInputStreams } from './subscribe'
import { encodeReply, wireFailure, wireStream, wireSuccess } from './wire'

const handleEvent = (kind: 'event.emit' | 'event.broadcast') =>
  operation(function* (msg: Msg) {
    const decoded = (yield* JsonCodec.actions.decode(msg.data)) as TransportDef.EventRequest
    const broker = yield* useContext(Broker)

    broker.bus.emit(kind, decoded)
  })

export const handleEmit = handleEvent('event.emit')
export const handleBroadcast = handleEvent('event.broadcast')

export const handleDispatch = (service: Service, actionKey: string) =>
  operation(function* (msg: Msg) {
    const decoded = yield* attempt(JsonCodec.actions.decode(msg.data))

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

      const outcome: Result<unknown, unknown> = yield* attempt(
        invokeAction({
          service,
          actionKey,
          params: req.params ?? [],
          streams,
          contexts: req.contexts,
        }),
      )

      if (!isSuccess(outcome)) {
        unsubscribeInputs()
        yield* respond(wireFailure(outcome))
        return
      }

      if (outputSubject !== undefined && isStreamResult(outcome.value)) {
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
