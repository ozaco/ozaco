import type { Flow } from 'std:effect'

import type { Trace } from './trace'
import type { Wire } from './wire'

/** Portable per-call metadata (forwarded headers, auth material, request baggage). */
export type Meta = Record<string, string>

/** The internal representation of one dispatch, identical across every carrier. */
export interface Request {
  /** Per-dispatch correlation id — derives reply/lane/cancel/outcome addresses on the wire. */
  readonly cid: string
  readonly service: string
  readonly action: string
  /** The `value` plane payload (other planes travel as lanes/sources). */
  readonly params: unknown
  readonly meta: Meta
  readonly trace: Trace
  /** Maps to the carrier's dedupe window (JetStream `msgID`) — safe retry after unknown outcome. */
  readonly idempotencyKey?: string | undefined
}

/**
 * What a dispatch resolves to. Handler failures are folded into a `failure` reply (never raised
 * across carriers) so status/meta/cause fidelity survives every wire identically; infrastructure
 * errors still raise as Result failures.
 */
export type Reply =
  | {
      readonly kind: 'value'
      readonly cid: string
      readonly status?: number | undefined
      readonly meta: Meta
      readonly value: unknown
    }
  | {
      readonly kind: 'stream'
      readonly cid: string
      readonly status?: number | undefined
      readonly meta: Meta
      readonly flow: Flow<unknown, unknown>
      /** Raw byte lane (`chunks`) vs codec values. */
      readonly bytes: boolean
    }
  | {
      readonly kind: 'failure'
      readonly cid: string
      readonly status: number
      readonly meta: Meta
      readonly failure: Wire.Failure
    }

/** The mutable response draft a handler edits via `useResponse()`. */
export interface ResponseDraft {
  status?: number | undefined
  meta: Meta
}

/** What `useCall()` exposes inside a handler. */
export interface CallInfo {
  readonly service: string
  readonly action: string
  readonly serviceId: string
}

/** Caller-abandonment signal a `detach` handler can observe via `useSignal()`. */
export interface ActionSignal {
  aborted(): boolean
  /** Subscribe to the abort moment; returns the unsubscribe function. */
  onAbort(listener: () => void): () => void
}
