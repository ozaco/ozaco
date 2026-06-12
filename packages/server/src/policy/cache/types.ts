import type { PolicyDef } from 'server:core'

export const CachePolicyKey = 'cache' as const

export namespace Cache {
  export interface Options extends PolicyDef.Options {
    ttl?: number
    max?: number
    /** `'principal'` (default) keys the cache per caller-identity so different principals never
     * share an entry; `'none'` shares one entry across all callers (explicit opt-in). */
    vary?: 'principal' | 'none'
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
    vary: 'principal' | 'none'
    shouldCache?: (dispatchCtx: PolicyDef.DispatchContext) => boolean
    entries: Map<string, Entry>
  }
}
