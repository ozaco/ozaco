/**
 * The correlation spine carried on EVERY dispatch: one `requestId` per external request (the edge
 * mints it or accepts an inbound `x-request-id`, and always echoes it back), one `spanId` per
 * dispatch/plugin/carrier/edge step, `parentSpanId` linking the tree, and the ordered `lane` of
 * services the request passed through (`laneOf` renders `gw>todos>ai`).
 */
export namespace TraceDef {
  export type Origin = 'external' | 'internal'

  export interface Hop {
    readonly service: string
    readonly action: string
    readonly spanId: string
    readonly transport: string
    readonly ts: number
  }

  export interface Trace {
    readonly requestId: string
    readonly spanId: string
    readonly parentSpanId?: string | undefined
    readonly origin: Origin
    readonly serviceId: string
    readonly lane: readonly Hop[]
  }

  /** What a carrier puts on the wire (and the edge on HTTP headers) to continue a trace. */
  export interface Wire {
    readonly requestId: string
    readonly spanId: string
    readonly parentSpanId?: string | undefined
    readonly lane: readonly Hop[]
  }

  export type SpanKind =
    | 'edge'
    | 'dispatch'
    | 'plugin'
    | 'carrier'
    | 'db'
    | 'cache'
    | 'lane'
    | 'custom'
  export type SpanStatus = 'ok' | 'failed' | 'cancelled'

  /** A finished span as the kernel reports it. */
  export interface Span {
    readonly requestId: string
    readonly spanId: string
    readonly parentSpanId: string | null
    readonly kind: SpanKind
    readonly name: string
    readonly serviceId: string

    /** the node that ran it (`ServerDef.Options.instance`). */
    readonly instance: string

    /** `service.action` for dispatch spans (and whatever a plugin span names). */
    readonly actionId: string | null
    readonly transport: string | null
    readonly startedAt: number
    readonly endedAt: number
    readonly status: SpanStatus
    readonly attrs: Readonly<Record<string, unknown>> | null
  }

  export type OutcomeState = 'fulfilled' | 'failed' | 'cancelled'

  /** The owner-side truth about a dispatch whose reply could not be delivered normally. */
  export interface Outcome {
    readonly cid: string
    readonly state: OutcomeState
    readonly serviceId: string
    readonly actionId: string
    readonly error: string | null
    readonly ts: number
  }
}
