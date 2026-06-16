import { createContext } from 'std:effect'

import type { DaemonDef } from '../types'

export const DaemonCtxRef = createContext<DaemonDef.Context>('server:daemon:ctx')
