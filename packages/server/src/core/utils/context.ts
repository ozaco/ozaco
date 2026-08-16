import type { BoundLogger } from 'server:utils'
import { createContext } from 'std:effect'
import type { Context } from 'std:effect'

import type { ActionSignal, CallInfo, Request, ResponseDraft } from '../types/common'
import type { Trace } from '../types/trace'

/**
 * Public per-dispatch contexts. `invoke` plants all of them around every handler run — hooks in
 * `utils/hooks.ts` are thin readers over these; observers (metrics, tracing) may read them from
 * `around` middleware at any point of the chain.
 */
export const TraceContext: Context<Trace> = createContext<Trace>('server:core:trace')

export const RequestContext: Context<Request> = createContext<Request>('server:core:request')

export const ResponseContext: Context<ResponseDraft> =
  createContext<ResponseDraft>('server:core:response')

export const CallContext: Context<CallInfo> = createContext<CallInfo>('server:core:call')

/** The per-call bound logger (module + requestId/serviceId/actionId bindings). */
export const LogContext: Context<BoundLogger> = createContext<BoundLogger>('server:core:log')

export const SignalContext: Context<ActionSignal> =
  createContext<ActionSignal>('server:core:signal')

/** Non-value input planes (stream/multistream/socket) keyed by `DataType`. */
export const SourcesContext: Context<ReadonlyMap<string, unknown>> =
  createContext<ReadonlyMap<string, unknown>>('server:core:sources')
