import type { ActionRequest, PolicyDef, TracerDef } from 'server:core'
import type { Result } from 'std:result'

export const MetricsPolicyKey = 'metrics' as const

export namespace Metrics {
  export interface Event {
    serviceName: string
    actionKey: string
    startedAt: number
    durationMs: number
    /** The edge envelope this dispatch serves — absent when the call runs outside a request scope
     * (background task, engine tick). Headers/meta carry whatever identity the edge attached. */
    request?: ActionRequest | undefined
    /** The dispatch's span — `traceId` correlates every call of one request tree. */
    trace?: TracerDef.SpanContext | undefined
  }

  export type CallEvent = Pick<
    Event,
    'serviceName' | 'actionKey' | 'startedAt' | 'request' | 'trace'
  >

  export interface SuccessEvent extends Event {
    value: unknown
  }

  export interface FailureEvent extends Event {
    failure: Result.Failure<unknown>
  }

  export interface Options extends PolicyDef.Options {
    onCall?: (event: CallEvent) => void
    onSuccess?: (event: SuccessEvent) => void
    onFailure?: (event: FailureEvent) => void
  }

  export interface Context extends PolicyDef.Context {
    onCall?: (event: CallEvent) => void
    onSuccess?: (event: SuccessEvent) => void
    onFailure?: (event: FailureEvent) => void
  }
}
