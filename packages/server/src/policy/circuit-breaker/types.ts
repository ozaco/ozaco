import type { PolicyDef } from 'server:core'
import type { Result } from 'std:result'

export const CircuitBreakerPolicyKey = 'circuitBreaker' as const

export namespace CircuitBreaker {
  export type State = 'closed' | 'open' | 'half-open'

  export interface Options extends PolicyDef.Options {
    threshold?: number
    resetTimeout?: number
    halfOpenMax?: number
    isFailure?: (failure: Result.Failure<unknown>) => boolean
  }

  export interface Entry {
    state: State
    failures: number
    halfOpenInflight: number
    openedAt: number
  }

  export interface Context extends PolicyDef.Context {
    threshold: number
    resetTimeout: number
    halfOpenMax: number
    isFailure?: (failure: Result.Failure<unknown>) => boolean
    entries: Map<string, Entry>
  }
}
