import { attempt, operation, scoped } from 'std:effect'
import type { Flow } from 'std:effect'
import { appendCauses, fail, isFailure } from 'std:result'

import { CoreErrors } from '../errors'
import { BrokerRef } from '../internal/context'
import { createActionSignal } from '../internal/outcome'
import type { BrokerDef } from '../types/broker'
import type { ActionSignal, Reply, Request, ResponseDraft } from '../types/common'

import {
  CallContext,
  LogContext,
  RequestContext,
  ResponseContext,
  SignalContext,
  SourcesContext,
  TraceContext,
} from './context'
import { statusFor } from './status'
import { breadcrumb, laneOf, withServiceId } from './trace'
import { toWireFailure } from './wire'

export interface InvokeInput {
  readonly entry: BrokerDef.ServiceEntry
  readonly request: Request
  readonly acked: () => void
  readonly signal?: ActionSignal | undefined
  readonly sources?: ReadonlyMap<string, unknown> | undefined
}

/**
 * THE single local invoker every carrier shares. Plants the per-dispatch contexts (trace, request,
 * response draft, call info, bound logger with the correlation ids, abandon signal), fires the
 * fulfillment ack, runs the action, and folds handler failures into a full-fidelity failure reply.
 */
export const invokeLocal = operation(function* ({
  entry,
  request,
  acked,
  signal,
  sources,
}: InvokeInput) {
  const { service, serviceId } = entry
  const action = service.actions[request.action]

  if (!action) {
    return yield* fail(
      CoreErrors.NoRoute,
      `action "${service.name}.${request.action}" does not exist`,
      `invoke: cid:${request.cid}`,
    )
  }

  const broker = yield* BrokerRef.expect()
  const trace = withServiceId(request.trace, serviceId)
  const log = broker.log.child({
    requestId: trace.requestId,
    serviceId,
    actionId: trace.actionId,
  })

  return yield* scoped(function* () {
    const draft: ResponseDraft = { status: undefined, meta: {} }

    yield* TraceContext.set(trace)
    yield* RequestContext.set({ ...request, trace })
    yield* ResponseContext.set(draft)
    yield* CallContext.set({ service: service.name, action: request.action, serviceId })
    yield* LogContext.set(log)
    yield* SignalContext.set(signal ?? createActionSignal())

    if (sources) {
      yield* SourcesContext.set(sources)
    }

    acked()

    const started = Date.now()

    yield* log.debug('action started', {
      service: service.name,
      action: request.action,
      cid: request.cid,
      lane: laneOf(trace),
      origin: trace.origin,
    })

    const outcome = yield* attempt(() => action(request.params))

    if (isFailure(outcome)) {
      appendCauses(outcome, breadcrumb(trace, request.action))

      const status = statusFor(outcome, action.meta.errors)

      yield* log.error('action failed', {
        service: service.name,
        action: request.action,
        cid: request.cid,
        durationMs: Date.now() - started,
        error: String(outcome.error),
        status,
        lane: laneOf(trace),
        causes: [...outcome.causes],
      })

      const reply: Reply = {
        kind: 'failure',
        cid: request.cid,
        status,
        meta: draft.meta,
        failure: toWireFailure(outcome, { status }),
      }

      return reply
    }

    yield* log.debug('action fulfilled', {
      service: service.name,
      action: request.action,
      cid: request.cid,
      durationMs: Date.now() - started,
    })

    if (action.meta.wire.streamingOut) {
      const reply: Reply = {
        kind: 'stream',
        cid: request.cid,
        status: draft.status,
        meta: draft.meta,
        flow: outcome.value as Flow<unknown, unknown>,
        bytes: action.meta.wire.bytesOut,
      }

      return reply
    }

    const reply: Reply = {
      kind: 'value',
      cid: request.cid,
      status: draft.status,
      meta: draft.meta,
      value: outcome.value,
    }

    return reply
  })
})
