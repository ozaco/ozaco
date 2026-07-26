import { createContext } from 'std:effect'

import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { Request } from '../types/common'
import type { ActionRequest, ActionResponse, ResponseSink } from '../types/gateway'
import type { RoleResolver } from '../types/role'
import type { Service } from '../types/service'
import type { Source } from '../types/source'
import type { TracerDef } from '../types/tracer'
import type { TransportDef } from '../types/transport'

export const ActionContext = createContext<Action>('server:core:action')
export const ServiceContext = createContext<Service>('server:core:service')
export const CallContext = createContext<BrokerDef.CallContext>('server:core:call')
export const TraceContext = createContext<TracerDef.SpanContext>('server:core:trace')

/**
 * The portable {@link Request} the current action is serving.
 *
 * Distinct from `ActionRequestContext`, which is the HTTP-shaped envelope an edge built. This one
 * is what every carrier agrees on — origin, address, meta, sources — so `useRequest()` answers the
 * same thing whether the call arrived in-process, over nats or from a worker.
 */
/**
 * How this process was deployed, published by whoever orchestrates it.
 *
 * Absent in a plain single-process app, and that absence is what makes self-wiring default to
 * own + serve — so nothing that exists today changes until a daemon says otherwise.
 */
export const RoleContext = createContext<RoleResolver | undefined>('server:core:role')

export const RequestContext = createContext<Request>('server:core:request')

export const ActionRequestContext = createContext<ActionRequest>('server:action:request')
export const ActionResponseContext = createContext<ActionResponse>('server:action:response')
export const ActionSignalContext = createContext<AbortSignal>('server:action:signal')

/** Optional: when a gateway sets this, a transport streams an action's byte `Stream` result straight
 * to the client through the sink instead of returning it as a buffered value. */
export const ResponseSinkContext = createContext<ResponseSink>('server:action:response-sink')

/**
 * Sources the EDGE produced, on their way into the request.
 *
 * A door, not a destination: `dispatchAction` drains this into `request.sources` and everything
 * downstream asks `useSource`. It exists because a surface discovers a multipart body while parsing
 * headers, well before the request envelope is assembled — and the alternative was a hook of its
 * own per source kind, which is how `useMultipart` came to be a second way of asking the question
 * `useSource` already answers.
 */
export const EdgeSourcesContext = createContext<Source.Any[]>('server:core:edge-sources', [])

/** Flatten an `ActionRequest` into the serializable envelope carried over a transport. */
export const toRequestEnvelope = (req: ActionRequest): TransportDef.RequestEnvelope => ({
  type: req.type,
  method: req.method,
  url: req.url.toString(),
  meta: req.meta,
})

/** Rebuild an `ActionRequest` on the far side of a transport; `url` is re-parsed from its string
 * form. File parts are NOT part of this envelope — they travel as sources, over their own lanes. */
export const fromRequestEnvelope = (envelope: TransportDef.RequestEnvelope): ActionRequest => ({
  type: envelope.type as ActionRequest['type'],
  method: envelope.method,
  url: new URL(envelope.url),
  meta: envelope.meta,
})
