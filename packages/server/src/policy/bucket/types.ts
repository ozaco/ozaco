import type { PolicyDef } from 'server:core'
import type { Helpers, Scope } from 'std:effect'

export namespace Bucket {
  export interface Options extends PolicyDef.Options {
    interval?: number
    max?: number
  }

  export interface Entry {
    count: number
    resolvers: Helpers.WithResolvers<unknown>
    timer?: ReturnType<typeof setTimeout>
  }

  export interface Context extends PolicyDef.Context {
    interval: number
    max: number
    entries: Map<string, Entry>
    scope: Scope
  }
}
