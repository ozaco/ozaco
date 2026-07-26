import type {
  Action,
  ActionRequest,
  ActionResponse,
  GatewayDef,
  Response,
  Service,
} from 'server:core'
import {
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
  Broker,
  DataType,
  EXTERNAL_ORIGIN,
  ResponseSinkContext,
  EdgeSourcesContext,
  isService,
  valuesOf,
} from 'server:core'
import type { Stream } from 'std:effect'
import { operation } from 'std:effect'

import { ConnectionContext } from './const'

export interface DispatchEnvelope {
  req: ActionRequest
  res: ActionResponse
  /** the live connection, for a socket exchange; absent for a plain request */
  connection?: unknown
  signal?: AbortSignal | undefined
}

/**
 * THE SEAM. Establish the request-scoped action contexts, then invoke the action. Service actions go
 * through `Broker.actions.call` so the policy chain + tracing run (the contexts survive into the
 * action across the broker's scoped() boundary via prototype-chained scopes). Standalone actions
 * (framework internals like cors preflight / docs routes, not owned by a registered service) can't
 * be resolved by the broker, so they run directly within the same context onion.
 */
// oxlint-disable-next-line max-params
export const dispatchAction = operation(function* (
  envelope: DispatchEnvelope,
  route: GatewayDef.RegisteredRoute,
  action: Action,
  body: unknown,
) {
  // Through the broker only when the route has an ADDRESS. A bare action mounted on its own has no
  // service and no path, so there is nothing to route by — it runs here, in this same context
  // onion. Passing the action object itself is no longer an option, and that is the point: the
  // broker used to ask the plugin runtime which service owned it, which a gateway cannot do for a
  // service it merely mounted and never installed.
  const addressed = isService(route.target) && route.key !== undefined

  /**
   * Fold the answer's envelope back into the edge's draft.
   *
   * For a LOCAL call this is a no-op: the transport reuses the draft the edge already installed, so
   * the action wrote straight into `envelope.res`. It earns its keep across a wire — the owner's
   * draft lives on another node, and its status and headers reach us only in the `Response`. Before
   * the reply carried them, `useResponse()` was a local-only convenience that silently stopped
   * working the day a service moved to another pod.
   */
  const adopt = function* (response: Response) {
    if (response.status !== undefined) {
      envelope.res.status = response.status
    }
    Object.assign(envelope.res.meta, response.meta)

    /**
     * A lane that arrived over a wire is handed to the sink HERE.
     *
     * In-process the owner does it itself, inside the scope that produced the stream. Across a wire
     * there is no sink on the owner — it is headless — so the lane travels in the envelope and this
     * is the first place that has one. Without this the edge saw a response with no `normal` source
     * and answered 204, quietly dropping a body that had already crossed the network.
     */
    const lane = response.sources.find(source => source.type === DataType.stream)
    const sink = yield* ResponseSinkContext.get()

    if (lane?.type === DataType.stream && sink) {
      yield* sink.respond(lane.stream as Stream<Uint8Array, unknown>)
      return undefined
    }

    // the one place that legitimately takes a value out of an envelope: it has just read the
    // status and headers off the same object
    return valuesOf(response.sources)[0]
  }

  const invoke = function* () {
    if (!addressed) {
      return yield* action(body)
    }

    // Whatever the edge produced while parsing joins the body on the way in, so everything
    // downstream has exactly one way to ask for it.
    const edge = (yield* EdgeSourcesContext.get()) ?? []

    return yield* adopt(
      (yield* Broker.actions.exchange(
        route.target as Service,
        route.key as never,
        [{ type: DataType.normal, value: body }, ...edge],
        // EXTERNAL, set here and nowhere else: the edge is the only thing that knows a call came
        // from outside, and it is a symbol so nothing in a payload can claim it.
        { origin: EXTERNAL_ORIGIN },
      )) as Response,
    )
  }

  return yield* ActionRequestContext.with(envelope.req, () =>
    ActionResponseContext.with(envelope.res, () =>
      ConnectionContext.with(envelope.connection, () =>
        envelope.signal ? ActionSignalContext.with(envelope.signal, invoke) : invoke(),
      ),
    ),
  )
})
