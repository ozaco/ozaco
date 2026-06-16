import type { Action, BrokerDef, Service, TransportDef } from 'server:core'
import {
  ActionRequestContext,
  CallContext,
  CoreErrors,
  fromRequestEnvelope,
  StreamContext,
  TraceContext,
} from 'server:core'
import type { Stream } from 'std:effect'
import { operation } from 'std:effect'
import { Logger } from 'std:logger'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

export interface InvokeArgs {
  service: Service
  actionKey: string
  params: unknown[]
  streams: Stream<unknown, void>[]
  contexts?: TransportDef.DispatchContexts | undefined
}

/**
 * Invoke a registered service action with the full server context stack — `CallContext`,
 * `StreamContext`, an optional `TraceContext`, and a `Logger.child` span. Shared by every transport
 * that serves local actions (internal, nats, worker) so the invocation semantics stay identical.
 */
export const invokeAction = operation(function* (args: InvokeArgs) {
  const { service, actionKey, params, streams, contexts } = args
  const { raw: rawReq, request, trace: traceContext } = contexts ?? {}

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

  // rebuild the caller's request context (auth headers etc.) when the transport carried it across the
  // wire — local transports already inherit it through the scope, but remote ones (nats/worker) do not.
  const withRequest = request
    ? function* () {
        return yield* ActionRequestContext.with(fromRequestEnvelope(request), invoke)
      }
    : invoke

  if (traceContext) {
    return yield* TraceContext.with(traceContext as AnyType, withRequest)
  }

  return yield* withRequest()
})
