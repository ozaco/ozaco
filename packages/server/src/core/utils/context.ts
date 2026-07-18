import type { Stream } from 'std:effect'
import { createContext } from 'std:effect'

import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { ActionRequest, ActionResponse, MultipartPart, ResponseSink } from '../types/gateway'
import type { Service } from '../types/service'
import type { TracerDef } from '../types/tracer'
import type { TransportDef } from '../types/transport'

export const ActionContext = createContext<Action>('server:core:action')
export const ServiceContext = createContext<Service>('server:core:service')
export const CallContext = createContext<BrokerDef.CallContext>('server:core:call')
export const TraceContext = createContext<TracerDef.SpanContext>('server:core:trace')
export const StreamContext = createContext<Stream<unknown, void>[]>('server:core:streams', [])

export const ActionRequestContext = createContext<ActionRequest>('server:action:request')
export const ActionResponseContext = createContext<ActionResponse>('server:action:response')
export const ActionRawRequestContext = createContext<unknown>('server:action:raw-request')
export const ActionRawResponseContext = createContext<unknown>('server:action:raw-response')
export const ActionSignalContext = createContext<AbortSignal>('server:action:signal')

/** Optional: when a gateway sets this, a transport streams an action's byte `Stream` result straight
 * to the client through the sink instead of returning it as a buffered value. */
export const ResponseSinkContext = createContext<ResponseSink>('server:action:response-sink')

/** Set by the REST transformer on a `multipart: 'stream'` route: the lazy stream of body parts the
 * action pulls via `useMultipart()`. The body is not parsed until the action subscribes. */
export const MultipartContext =
  createContext<Stream<MultipartPart, unknown>>('server:action:multipart')

/** Flatten an `ActionRequest` into the serializable envelope carried over a transport. */
export const toRequestEnvelope = (req: ActionRequest): TransportDef.RequestEnvelope => ({
  type: req.type,
  method: req.method,
  url: req.url.toString(),
  meta: req.meta,
})

/** Rebuild an `ActionRequest` on the far side of a transport. File streams cannot cross the wire, so
 * `files` comes back empty; `url` is re-parsed from its string form. */
export const fromRequestEnvelope = (envelope: TransportDef.RequestEnvelope): ActionRequest => ({
  type: envelope.type as ActionRequest['type'],
  method: envelope.method,
  url: new URL(envelope.url),
  meta: envelope.meta,
  files: {},
})
