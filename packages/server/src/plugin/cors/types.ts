import type { ActionRequest, ActionResponse } from 'server:core'

export namespace CorsDef {
  export type Origin =
    | '*'
    | true
    | string
    | readonly string[]
    | RegExp
    | ((origin: string) => boolean)

  export interface Options {
    origin?: CorsDef.Origin
    methods?: readonly string[]
    allowedHeaders?: readonly string[]
    exposedHeaders?: readonly string[]
    credentials?: boolean
    maxAge?: number | string
    preflightStatus?: number
  }

  export interface Context {
    origin: CorsDef.Origin
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
}
