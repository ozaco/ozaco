import { ensure, operation, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { CoreErrors } from '../const'
import { Broker, Transport } from '../definitions'
import { resolveService } from '../internal/helpers'
import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { TransportDef } from '../types/transport'
import { CallContext, TraceContext } from '../utils/context'
import { registerTransport, unregisterTransport } from '../utils/transport-registry'

const getSelf = (): TransportDef => InternalTransport

export const InternalTransport = Transport.implement({
  name: 'server/internal-transport',
  version: '0.0.0',
  *setup(options: TransportDef.Options = {}) {
    const name = options.name ?? 'server/internal-transport'
    const priority = options.priority ?? 999
    const next = options.next ?? false

    const context: TransportDef.Context = { name, next, priority }

    yield* registerTransport(getSelf(), context)
    yield* ensure(function* () {
      yield* unregisterTransport(getSelf())
    })

    return context
  },
}).build({
  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const { serviceName, actionKey, params = [], rawReq, traceContext } = req

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

    const invoke = function* () {
      return yield* CallContext.with(callValue, function* () {
        const runBody = function* () {
          const result = yield* action(...params)
          return result === undefined ? callValue.raw.res : result
        }

        if (hasLogger) {
          return yield* Logger.actions.child(
            { service: registeredName, action: actionKey },
            runBody,
          )
        }

        return yield* runBody()
      })
    }

    if (traceContext) {
      return yield* TraceContext.with(traceContext, invoke)
    }

    return yield* invoke()
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
