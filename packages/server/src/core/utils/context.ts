import type { Stream } from 'std:effect'
import { createContext } from 'std:effect'

import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { ActionRequest, ActionResponse, ResponseSink } from '../types/gateway'
import type { Service } from '../types/service'
import type { TracerDef } from '../types/tracer'

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
