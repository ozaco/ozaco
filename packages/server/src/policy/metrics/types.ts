import type { TraceOrigin } from 'server:core'

/**
 * One completed dispatch as observed at the caller-side policy layer. `causes` stays a raw string
 * array here — the metrics collector serializes it (JsonCodec) at flush time, never in the sync
 * hook path.
 */
export interface CallEvent {
  readonly ts: number
  readonly service: string
  readonly action: string
  readonly status: 'success' | 'failure'
  readonly durationMs: number
  readonly requestId: string
  readonly serviceId: string
  readonly laneId: string
  readonly actionId: string
  readonly parentActionId?: string | undefined
  readonly outcome: 'fulfilled' | 'failed' | 'cancelled' | 'unknown'
  readonly delivered: boolean
  readonly origin: TraceOrigin
  readonly transport: string
  readonly error?: string | undefined
  readonly causes?: readonly string[] | undefined
}

/** The sync sink the metrics collector plants — MUST never throw and never cross into effects. */
export interface MetricsSink {
  call(event: CallEvent): void
}
