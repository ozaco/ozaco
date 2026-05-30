import type { PolicyDef } from 'server:core'

export const CachePolicyKey = 'cache' as const

export namespace Cache {
  export interface Options extends PolicyDef.Options {
    ttl?: number
    max?: number
    shouldCache?: (dispatchCtx: PolicyDef.DispatchContext) => boolean
  }

  export interface Entry {
    value: unknown
    expiresAt: number
    timer: ReturnType<typeof setTimeout>
  }

  export interface Context extends PolicyDef.Context {
    ttl: number
    max: number
    shouldCache?: (dispatchCtx: PolicyDef.DispatchContext) => boolean
    entries: Map<string, Entry>
  }
}
