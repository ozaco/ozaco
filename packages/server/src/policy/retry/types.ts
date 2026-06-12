import type { PolicyDef } from 'server:core'
import type { Result } from 'std:result'

export const RetryPolicyKey = 'retry' as const

export namespace Retry {
  export interface Options extends PolicyDef.Options {
    attempts?: number
    delay?: number
    backoff?: number
    maxDelay?: number
    when?: (failure: Result.Failure<unknown>) => boolean
    retryStreams?: boolean
  }

  export interface Context extends PolicyDef.Context {
    attempts: number
    delay: number
    backoff: number
    maxDelay: number
    when?: (failure: Result.Failure<unknown>) => boolean
    retryStreams: boolean
  }
}
