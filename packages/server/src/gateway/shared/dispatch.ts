import type { Action, ActionRequest, ActionResponse } from 'server:core'
import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
  Broker,
} from 'server:core'
import { operation } from 'std:effect'

export interface DispatchEnvelope {
  req: ActionRequest
  res: ActionResponse
  rawReq: unknown
  rawRes: unknown
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
  action: Action,
  body: unknown,
  viaBroker: boolean,
) {
  const invoke = () =>
    viaBroker ? Broker.actions.call(action, [body], { rawReq: envelope.rawReq }) : action(body)

  return yield* ActionRequestContext.with(envelope.req, () =>
    ActionResponseContext.with(envelope.res, () =>
      ActionRawRequestContext.with(envelope.rawReq, () =>
        ActionRawResponseContext.with(envelope.rawRes, () =>
          envelope.signal ? ActionSignalContext.with(envelope.signal, invoke) : invoke(),
        ),
      ),
    ),
  )
})
