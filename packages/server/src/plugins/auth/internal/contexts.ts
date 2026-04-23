import { createContext } from 'std:effect'
import type { EventSource } from 'std:event'

import type { AuthEvents, AuthProvider, JWTAlgorithm } from '../types'

export interface BaseAuthContext {
  issuer: string | null
  audience: string | null
  algorithm: JWTAlgorithm

  verificationTTL: number
}

export const AuthBaseCtxRef = createContext<BaseAuthContext>('server:auth:base-ctx')
export const AuthSecretRef = createContext<Uint8Array>('server:auth:secret')
export const AuthProviderRef = createContext<AuthProvider | null>('server:auth:provider', null)
export const AuthEventsRef = createContext<EventSource<AuthEvents>>('server:auth:events')
