import type { ActionRequest, ActionResponse } from 'server:core'

export type CorsOrigin =
  | '*'
  | true
  | string
  | readonly string[]
  | RegExp
  | ((origin: string) => boolean)

export interface CorsOptions {
  origin?: CorsOrigin
  methods?: readonly string[]
  allowedHeaders?: readonly string[]
  exposedHeaders?: readonly string[]
  credentials?: boolean
  maxAge?: number | string
  preflightStatus?: number
}

export interface CorsContext {
  origin: CorsOrigin
  methods: string
  allowedHeaders: string
  exposedHeaders: string | null
  credentials: boolean
  maxAge: string
  preflightStatus: number
}

export interface ResolvedOrigin {
  allow: string | null
  vary: boolean
}

export type FromInternalArgs = [ActionRequest | null, ActionResponse | null, unknown, unknown]
