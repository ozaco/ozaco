import type { Action, BrokerDef, Service, TransportDef } from 'server:core'
import { Broker, CallContext, Codec, CoreErrors, StreamContext, TraceContext } from 'server:core'
import type { Stream } from 'std:effect'
import { isStream, operation, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, fail, isSuccess, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Msg } from 'nats'

import { useNatsContext } from '../internal'
import type { Nats } from '../types'

import { pumpToNats, subscribeFromNats } from './stream'
import { wireFailure, wireStream, wireSuccess } from './wire'

interface InvokeArgs {
  service: Service
  actionKey: string
  params: unknown[]
  streams: Stream<unknown, void>[]
  rawReq: unknown
  traceContext: unknown
}

const invokeAction = operation(function* (args: InvokeArgs) {
  const { service, actionKey, params, streams, rawReq, traceContext } = args

  const action = (service.actions as Record<string, AnyType>)[actionKey]

  if (typeof action !== 'function') {
    return yield* fail(
      CoreErrors.NotFound,
      `action "${actionKey}" not found on service "${service.name}"`,
    )
  }

  const callValue: BrokerDef.CallContext = {
    service,
    serviceName: service.name,

    action: action as Action,
    actionKey,

    raw: { req: rawReq, res: undefined },
  }

  const hasLogger = (yield* Logger.context.get()) !== undefined

  const invoke = function* () {
    return yield* CallContext.with(callValue, function* () {
      return yield* StreamContext.with(streams, function* () {
        const runBody = function* () {
          const result = yield* action(...params)
          return result === undefined ? callValue.raw.res : result
        }

        if (hasLogger) {
          return yield* Logger.actions.child({ service: service.name, action: actionKey }, runBody)
        }

        return yield* runBody()
      })
    })
  }

  if (traceContext) {
    return yield* TraceContext.with(traceContext as AnyType, invoke)
  }

  return yield* invoke()
})

const encodeReply = operation(function* (wire: Nats.Wire) {
  try {
    return yield* Codec.actions.encode(wire)
  } catch (error) {
    return yield* Codec.actions.encode({
      _t: '__failure__',
      error: 'server:core.codec-encode',
      message: 'failed to encode response',
      causes: [String(error)],
    } satisfies Nats.Wire)
  }
})

const captureInputStreams = function* (inputSubjects: string[]) {
  const nats = yield* useNatsContext()
  const streams: Stream<unknown, void>[] = []
  const subs: { unsubscribe: () => void; isClosed: () => boolean }[] = []

  for (const subject of inputSubjects) {
    const sub = nats.connection.subscribe(subject)
    subs.push(sub)
    const stream = yield* subscribeFromNats(sub, nats.scope)
    streams.push(stream as Stream<unknown, void>)
  }

  return { streams, subs }
}

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
    const inputSubjects = req.inputSubjects ?? []
    const outputSubject = req.outputSubject

    const { streams, subs } = yield* captureInputStreams(inputSubjects)

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
      for (const sub of subs) {
        if (!sub.isClosed()) {
          sub.unsubscribe()
        }
      }
      if (msg.reply) {
        msg.respond(yield* encodeReply(wireFailure(outcome)))
      }
      return
    }

    if (outputSubject !== undefined && isStream(outcome.value)) {
      const nats = yield* useNatsContext()
      const output = outcome.value

      if (msg.reply) {
        msg.respond(yield* encodeReply(wireStream()))
      }

      try {
        yield* pumpToNats(nats.connection, outputSubject, output)
      } finally {
        for (const sub of subs) {
          if (!sub.isClosed()) {
            sub.unsubscribe()
          }
        }
      }
      return
    }

    for (const sub of subs) {
      if (!sub.isClosed()) {
        sub.unsubscribe()
      }
    }

    if (msg.reply) {
      msg.respond(yield* encodeReply(wireSuccess(outcome.value)))
    }
  })
