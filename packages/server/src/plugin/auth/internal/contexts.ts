import { createContext } from 'std:effect'
import type { EventEmitter } from 'std:event'

import type { AuthDef } from '../types'

export const AuthBaseCtxRef = createContext<AuthDef.BaseContext>('server:auth:base-ctx')
export const AuthSignKeyRef = createContext<AuthDef.ResolvedKey>('server:auth:sign-key')
export const AuthVerifyKeyRef = createContext<AuthDef.ResolvedKey>('server:auth:verify-key')
export const AuthProviderRef = createContext<AuthDef.Provider | null>('server:auth:provider', null)
export const AuthEventsRef = createContext<EventEmitter<AuthDef.Events>>('server:auth:events')

export const AccessStrategyCtxRef = createContext<AuthDef.AccessRefreshContext>(
  'server:auth:access-refresh:ctx',
)

export const JwtStrategyCtxRef = createContext<AuthDef.JWTSessionContext>(
  'server:auth:jwt-session:ctx',
)
