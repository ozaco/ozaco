import { boundLogger } from 'server:utils'
import type { BoundLogger } from 'server:utils'
import { operation } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail } from 'std:result'

import type { DataType } from '../const'
import { CoreErrors } from '../errors'
import { BrokerRef } from '../internal/context'
import type { BrokerContext } from '../types/broker'
import type { ActionSignal, CallInfo, Request, ResponseDraft } from '../types/common'
import type { Trace } from '../types/trace'

import {
  CallContext,
  LogContext,
  RequestContext,
  ResponseContext,
  SignalContext,
  SourcesContext,
  TraceContext,
} from './context'

/** The correlation spine of the current dispatch. */
export const useTrace = (): Operation<Trace> => TraceContext.expect()

/** The raw request envelope of the current dispatch. */
export const useRequest = (): Operation<Request> => RequestContext.expect()

/** The mutable response draft (status + meta) of the current dispatch. */
export const useResponse = (): Operation<ResponseDraft> => ResponseContext.expect()

/** Which service/action instance is handling the current dispatch. */
export const useCall = (): Operation<CallInfo> => CallContext.expect()

/** The caller-abandonment signal (`detach` handlers observe it and keep working). */
export const useSignal = (): Operation<ActionSignal> => SignalContext.expect()

/** The running broker context — the seam remote carriers use to reach the local registry. */
export const useBroker = (): Operation<BrokerContext> => BrokerRef.expect()

/** The per-call bound logger (requestId/serviceId/actionId bindings included). */
export const useLog = operation(function* () {
  return ((yield* LogContext.get()) ?? (yield* boundLogger({}))) as BoundLogger
})

/** A non-value input plane (stream/multistream/socket) declared on the action's wire. */
export const useSource = operation(function* (type: DataType) {
  const sources = yield* SourcesContext.get()
  const source = sources?.get(type)

  if (source === undefined) {
    return yield* fail(CoreErrors.BadRequest, `this dispatch carries no "${type}" source`)
  }

  return source
})
