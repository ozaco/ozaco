/** Where a request tree entered the system. */
export type TraceOrigin = 'external' | 'internal'

/** One service the request passed through, in order. */
export interface Hop {
  readonly service: string
  readonly action: string
  readonly actionId: string
  readonly transport: string
  readonly ts: number
}

/**
 * The correlation spine carried on EVERY dispatch (requirement: request-id / service-id / lane-id /
 * action-id, end to end).
 *
 * - `requestId` — one per external request; the edge mints it (or accepts a valid inbound
 *   `x-request-id`) and always echoes it back in the response.
 * - `serviceId` — the service instance currently processing (`name@version#instance`).
 * - `actionId` — unique per action invocation; `parentActionId` links the in-process chain.
 * - `lane` — the ordered hops the request took (`laneOf(trace)` renders `gw>todos>ai`).
 */
export interface Trace {
  readonly requestId: string
  readonly origin: TraceOrigin
  readonly serviceId: string
  readonly actionId: string
  readonly parentActionId?: string | undefined
  readonly lane: readonly Hop[]
}

/** The owner-side truth about whether a dispatched action actually ran to completion. */
export type OutcomeState = 'fulfilled' | 'failed' | 'cancelled'

/**
 * A tiny record stored when a reply could not be delivered normally (or on opt-in), so a caller
 * that hit `TimeoutPending` — or its restarted successor — can reconcile within the TTL window.
 * Never carries the response value itself.
 */
export interface Outcome {
  readonly cid: string
  readonly state: OutcomeState
  readonly ts: number
  readonly serviceId: string
  readonly actionId: string
  readonly error?: string | undefined
}
