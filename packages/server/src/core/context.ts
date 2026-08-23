import { createContext } from 'std:effect'

import type { ServerDef } from './types/server'
import type { TraceDef } from './types/trace'

/** The trace of the operation currently running (set per dispatch / edge request / span). */
export const TraceRef = createContext<TraceDef.Trace>('server:trace')

/** The handler context of the dispatch currently running. */
export const CtxRef = createContext<ServerDef.Ctx>('server:ctx')
