import type { PolicyDef } from 'server:core'
import type { Result } from 'std:result'

export const MetricsPolicyKey = 'metrics' as const

export namespace Metrics {
  export interface Event {
    serviceName: string
    actionKey: string
    startedAt: number
    durationMs: number
  }

  export interface SuccessEvent extends Event {
    value: unknown
  }

  export interface FailureEvent extends Event {
    failure: Result.Failure<unknown>
  }

  export interface Options extends PolicyDef.Options {
    onCall?: (event: Pick<Event, 'serviceName' | 'actionKey' | 'startedAt'>) => void
    onSuccess?: (event: SuccessEvent) => void
    onFailure?: (event: FailureEvent) => void
  }

  export interface Context extends PolicyDef.Context {
    onCall?: (event: Pick<Event, 'serviceName' | 'actionKey' | 'startedAt'>) => void
    onSuccess?: (event: SuccessEvent) => void
    onFailure?: (event: FailureEvent) => void
  }
}
