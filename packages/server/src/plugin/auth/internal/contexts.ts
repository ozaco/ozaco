import { createContext } from 'std:effect'
import type { EventSource } from 'std:event'

import type { AuthEvents, AuthProvider, BaseAuthContext, ResolvedKey } from '../types'

export const AuthBaseCtxRef = createContext<BaseAuthContext>('server:auth:base-ctx')
export const AuthSignKeyRef = createContext<ResolvedKey>('server:auth:sign-key')
export const AuthVerifyKeyRef = createContext<ResolvedKey>('server:auth:verify-key')
export const AuthProviderRef = createContext<AuthProvider | null>('server:auth:provider', null)
export const AuthEventsRef = createContext<EventSource<AuthEvents>>('server:auth:events')
