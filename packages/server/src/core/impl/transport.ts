import type { Stream } from 'std:effect'
import { ensure, operation, scoped, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { CoreErrors } from '../const'
import { Broker, Transport } from '../definitions'
import { resolveService } from '../internal/helpers'
import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { TransportDef } from '../types/transport'
import { CallContext, ResponseSinkContext, StreamContext, TraceContext } from '../utils/context'
import { isStreamResult } from '../utils/is'

const getSelf = (): TransportDef => InternalTransport

export const InternalTransport = Transport.implement({
  name: 'server/internal-transport',
  version: '0.0.0',
  *setup(options: TransportDef.Options = {}) {
    const name = options.name ?? 'server/internal-transport'
    const priority = options.priority ?? 0
    const next =
      options.next ?? ((failure: Result.Failure<unknown>) => failure.error === CoreErrors.NotFound)

    const context: TransportDef.Context = {
      name,
      priority,
      next,
    }

    yield* Transport.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Transport.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const { serviceName, actionKey, params = [], rawReq, traceContext } = req
    const streams = (req.streams ?? []) as Stream<unknown, void>[]

    const broker = yield* useContext(Broker)
    const resolved = resolveService(broker.services, serviceName)

    if (!resolved) {
      return yield* fail(
        CoreErrors.NotFound,
        `service "${serviceName}" not registered on broker "${broker.name}" (internal-transport has no remote fallback)`,
      )
    }

    const { service, registeredName } = resolved
    const action = (service.actions as Record<string, AnyType>)[actionKey]
    if (typeof action !== 'function') {
      return yield* fail(
        CoreErrors.NotFound,
        `action "${actionKey}" not found on service "${registeredName}"`,
      )
    }

    const callValue: BrokerDef.CallContext = {
      service,
      serviceName: registeredName,

      action: action as Action,
      actionKey,

      raw: { req: rawReq, res: undefined },
    }

    const hasLogger = (yield* Logger.context.get()) !== undefined

    return yield* scoped(function* () {
      const runBody = function* () {
        const result = yield* action(...params)
        return result === undefined ? callValue.raw.res : result
      }

      const invoke = function* () {
        return yield* CallContext.with(callValue, function* () {
          return yield* StreamContext.with(streams, function* () {
            return yield* hasLogger
              ? Logger.actions.child({ service: registeredName, action: actionKey }, runBody)
              : runBody()
          })
        })
      }

      let completed = false
      try {
        const result = yield* traceContext ? TraceContext.with(traceContext, invoke) : invoke()

        // streaming response: a gateway installed a sink and the action returned a Stream — hand it
        // back to the gateway HERE, inside this still-open scope, so the producer (and any upstream
        // request feeding it) stays alive while the body drains. completed is set first so a mid-stream
        // client disconnect (which halts the pump) is not logged as a fault.
        const sink = yield* ResponseSinkContext.get()
        if (sink && isStreamResult(result)) {
          completed = true
          yield* sink.respond(result as Stream<Uint8Array, unknown>)
          return undefined
        }

        completed = true
        return result
      } finally {
        if (!completed && hasLogger) {
          yield* Logger.actions.child({ service: registeredName, action: actionKey }, function* () {
            yield* Logger.actions.warn(
              'internal:handler-cancelled',
              asFailure(fail('cancelled', 'handler cancelled')),
            )
          })
        }
      }
    } as AnyType)
  }),

  emit: operation(function* (req: TransportDef.EventRequest) {
    const broker = yield* useContext(Broker)

    broker.bus.emit('event.emit', req.groups ? req : { name: req.name, payload: req.payload })
  }),

  broadcast: operation(function* (req: TransportDef.EventRequest) {
    const broker = yield* useContext(Broker)

    broker.bus.emit('event.broadcast', req.groups ? req : { name: req.name, payload: req.payload })
  }),
})
