import type { Operation, Stream } from 'std:effect'
import { attempt, operation } from 'std:effect'
import { Logger } from 'std:logger'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { CoreErrors } from '../const'
import type { BrokerDef } from '../types/broker'
import type { Request, Response } from '../types/common'
import type { ActionResponse } from '../types/gateway'
import type { Service } from '../types/service'
import type { TransportDef } from '../types/transport'
import {
  ActionRequestContext,
  ActionResponseContext,
  CallContext,
  RequestContext,
  ResponseSinkContext,
  TraceContext,
  fromRequestEnvelope,
} from '../utils/context'
import { fault } from '../utils/fault'
import { producesLane } from '../utils/is'

import { emptyDraft, toFault, toResponse, toSources } from './respond'
import { valuesOf } from './wire'

/** Says the sink took the lane, so the reply carries the envelope alone. Never leaves this file. */
const STREAMED = Symbol('server:core:streamed')

/**
 * Run one action, here, with the full context stack — and the ONLY place that does.
 *
 * Every carrier that serves a local action goes through this: the in-process one, nats, worker. It
 * used to be written twice, once in the internal transport and once in a shared helper, and the two
 * drifted exactly as you would expect — both reached through `service.actions[key]` (a proxy, which
 * answers every key with a callable, so the not-found guard could never fire), and only one of them
 * installed the reply draft, so `useResponse()` silently did nothing on a remote node.
 */
export const invokeLocal = operation(function* (
  service: Service,
  request: Request,
  contexts: TransportDef.DispatchContexts | undefined,
) {
  const { request: envelope, trace: traceContext } = contexts ?? {}

  // The service's OWN table. A proxy would have answered with a callable for any string.
  const action = yield* service.actions._get(request.path)

  if (!action) {
    return yield* fault(
      CoreErrors.NotFound,
      `action "${request.path}" not found on service "${service.name}"`,
    ) as unknown as Operation<Response>
  }

  const callValue: BrokerDef.CallContext = {
    service,
    serviceName: service.name,

    action,
    actionKey: request.path,
  }

  // The reply half. Reused when an edge already opened one, so an action writes into the draft the
  // gateway will read; created here otherwise, so a plain call — or a call that arrived over a wire
  // — can still set a status and have it travel home.
  const draft: ActionResponse = (yield* ActionResponseContext.get()) ?? emptyDraft()

  const params = valuesOf(request.sources)
  const hasLogger = (yield* Logger.context.get()) !== undefined

  /**
   * A lane is handed to the sink HERE, inside every scope the action ran in.
   *
   * Not after the body returns, which is where this used to sit. A file stream is a scope-bound
   * `resource`: when the action's scopes unwind, its listeners come off and the underlying handle
   * is destroyed. Draining it afterwards found a stream that had already been torn down — a clean
   * close with zero bytes, indistinguishable from an empty file. An in-memory lane survived that
   * ordering because it holds its data, which is exactly why the bug hid.
   */
  const runBody = function* () {
    const value = yield* action(...params)

    const sink = yield* ResponseSinkContext.get()
    if (sink && producesLane(action)) {
      yield* sink.respond(value as Stream<Uint8Array, unknown>)
      return STREAMED
    }

    return value
  }

  const body = function* () {
    return yield* RequestContext.with(request, () =>
      ActionResponseContext.with(draft, () =>
        CallContext.with(callValue, function* () {
          return yield* hasLogger
            ? Logger.actions.child({ service: service.name, action: request.path }, runBody)
            : runBody()
        }),
      ),
    )
  }

  /**
   * Rebuild the caller's request context ONLY when nothing already carries it.
   *
   * The envelope is what survives a wire, and by construction that is less than the real thing —
   * `files` holds live handles, so it comes back empty. In-process the scope already holds the
   * genuine `ActionRequest` the edge built, and rebuilding over it replaces a request that has the
   * uploaded files with one that does not.
   */
  const inherited = yield* ActionRequestContext.get()

  const withRequest =
    envelope && inherited === undefined
      ? function* () {
          return yield* ActionRequestContext.with(fromRequestEnvelope(envelope), body)
        }
      : body

  /**
   * A handler that FAILED still answered — and what it had already set has to survive.
   *
   * The distinction the previous core could not make: it tracked completion with a flag straddling
   * try/catch/finally and could not tell a handler that decided to fail from one that was cut
   * short. So every 4xx an application returned was logged as a cancelled handler, and whatever
   * status it had set on the way out was thrown away.
   */
  /**
   * A failure is reified; a halt is not.
   *
   * `attempt` turns a handler that DECIDED to fail into a value — that is an answer, and it goes on
   * to become a Fault below. A halt is not caught here at all and simply unwinds, which is the
   * correct shape: nothing may log or respond on the way out, because performing a new effect while
   * unwinding a halt is what breaks the unwind itself.
   */
  const outcome = yield* attempt(() =>
    traceContext ? TraceContext.with(traceContext as AnyType, withRequest) : withRequest(),
  )

  if (isFailure(outcome)) {
    return yield* fail(
      toFault(outcome.error, toResponse(draft, [])),
      outcome.message,
      ...outcome.causes,
    ) as unknown as Operation<Response>
  }

  const result = outcome.value

  // The sink already took the lane and drained it; the reply carries the envelope and no sources.
  if (result === STREAMED) {
    return toResponse(draft, [])
  }

  return toResponse(draft, toSources(result, action.wire.output))
})
