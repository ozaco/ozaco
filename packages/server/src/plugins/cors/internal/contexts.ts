import { createContext } from 'std:effect'

import type { CorsContext } from './types'

export const CorsCtxRef = createContext<CorsContext>('server:cors:ctx')
