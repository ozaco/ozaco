import { createContext } from 'std:effect'
import type { EventSource } from 'std:event'

import type { AuthEvents, AuthProvider, BaseAuthContext } from '../types'

export const AuthBaseCtxRef = createContext<BaseAuthContext>('server:auth:base-ctx')
export const AuthSecretRef = createContext<Uint8Array>('server:auth:secret')
export const AuthProviderRef = createContext<AuthProvider | null>('server:auth:provider', null)
export const AuthEventsRef = createContext<EventSource<AuthEvents>>('server:auth:events')
