import type { PolicyDef } from 'server:core'
import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

export const FallbackPolicyKey = 'fallback' as const

export namespace Fallback {
  export type Handler = (
    failure: Result.Failure<unknown>,
    ctx: PolicyDef.DispatchContext,
  ) => Operation<unknown, unknown>

  export interface Options extends PolicyDef.Options {
    value?: unknown
    handler?: Handler
    when?: (failure: Result.Failure<unknown>) => boolean
  }

  export interface Context extends PolicyDef.Context {
    value?: unknown
    handler?: Handler
    when?: (failure: Result.Failure<unknown>) => boolean
  }
}
