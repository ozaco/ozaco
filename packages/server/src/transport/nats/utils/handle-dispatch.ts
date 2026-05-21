import type { Action, BrokerDef, Service, TransportDef } from 'server:core'
import { CallContext, CoreErrors, TraceContext } from 'server:core'
import { operation } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, fail, isSuccess, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Msg } from 'nats'

import type { Nats } from '../types'

import { decodeMessage, encodeMessage, wireFailure, wireSuccess } from './wire'

const invokeAction = operation(function* (
  service: Service,
  actionKey: string,
  req: TransportDef.DispatchRequest,
) {
  const action = (service.actions as Record<string, AnyType>)[actionKey]

  if (typeof action !== 'function') {
    return yield* fail(
      CoreErrors.NotFound,
      `action "${actionKey}" not found on service "${service.name}"`,
    )
  }

  const { params = [], rawReq, traceContext } = req

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
      const runBody = function* () {
        const result = yield* action(...params)
        return result === undefined ? callValue.raw.res : result
      }

      if (hasLogger) {
        return yield* Logger.actions.child({ service: service.name, action: actionKey }, runBody)
      }

      return yield* runBody()
    })
  }

  if (traceContext) {
    return yield* TraceContext.with(traceContext, invoke)
  }

  return yield* invoke()
})

const encodeReply = operation(function* (wire: Nats.Wire) {
  try {
    return yield* encodeMessage(wire)
  } catch (error) {
    return yield* encodeMessage({
      _t: '__failure__',
      error: 'server:core.codec-encode',
      message: 'failed to encode response',
      causes: [String(error)],
    } satisfies Nats.Wire)
  }
})

export const handleDispatch = (service: Service, actionKey: string) =>
  operation(function* (msg: Msg) {
    let decoded: Result<unknown, unknown>
    try {
      decoded = succeed(yield* decodeMessage(msg.data))
    } catch (error) {
      decoded = asFailure(error)
    }

    if (!isSuccess(decoded)) {
      if (msg.reply) {
        msg.respond(yield* encodeReply(wireFailure(decoded)))
      }
      return
    }

    const req = decoded.value as TransportDef.DispatchRequest

    let outcome: Result<unknown, unknown>
    try {
      outcome = succeed(yield* invokeAction(service, actionKey, req))
    } catch (error) {
      outcome = asFailure(error)
    }

    if (!msg.reply) {
      return
    }

    const wire = isSuccess(outcome) ? wireSuccess(outcome.value) : wireFailure(outcome)
    msg.respond(yield* encodeReply(wire))
  })
