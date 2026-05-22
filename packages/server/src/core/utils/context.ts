import type { Stream } from 'std:effect'
import { createContext } from 'std:effect'

import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { Service } from '../types/service'
import type { TracerDef } from '../types/tracer'

export const ActionContext = createContext<Action>('server:core:action')
export const ServiceContext = createContext<Service>('server:core:service')
export const CallContext = createContext<BrokerDef.CallContext>('server:core:call')
export const TraceContext = createContext<TracerDef.SpanContext>('server:core:trace')
export const StreamContext = createContext<Stream<unknown, void>[]>('server:core:streams', [])
