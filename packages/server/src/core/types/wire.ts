import type { Result } from 'std:result'

/**
 * The ONE wire contract every carrier speaks: envelopes in, envelopes out. Values ride the
 * transport's codec; failures travel as the `Result.Failure` itself — the JsonCodec encodes a
 * failure and its nested causes (tag, message, causes — never a fold's `raw`) and rebuilds real
 * Failures; the decoder appends where it was answered as a string cause
 * (`remote: <operation> @ <service> span <id8>`).
 */
export namespace WireDef {
  /**
   * The trace context a dispatch / event envelope carries: the caller's W3C `traceparent` /
   * `tracestate` (the carrier's CLIENT span, or the emitter's PRODUCER span) and the request id
   * it belongs to. Carriers ALWAYS continue it (the sampled flag is honoured).
   *
   * Compat (one minor): new nodes also send `span_id` (the same span as `traceparent`) and an
   * empty `lane`, so pre-traceparent nodes keep parsing; an old envelope WITHOUT `traceparent` is
   * accepted — no parent, the `request_id` is kept.
   */
  export interface Trace {
    readonly traceparent?: string | undefined
    readonly tracestate?: string | undefined
    readonly request_id: string

    /** compat only — never read by current nodes. */
    readonly span_id?: string | undefined

    /** compat only — always `[]` from current nodes, never read. */
    readonly lane?: readonly unknown[] | undefined
  }

  /** One plane of a dispatch: which input/output streams exist and under which brand. */
  export interface Plane {
    readonly name: string
    readonly brand: string
  }

  export interface Dispatch {
    readonly k: 'dispatch'

    /** carrier correlation (lane topics, outcomes, cancel) — ALWAYS minted with `newSpanId()`,
     * never taken from a span (it exists with tracing off). */
    readonly cid: string
    readonly service: string
    readonly action: string
    readonly args: unknown
    readonly trace: Trace

    /** input streams the caller will pipe (`lane.<cid>.in.<name>`). */
    readonly inputs: readonly Plane[]

    /** absolute deadline (epoch ms) the caller stops waiting at. */
    readonly deadline: number
    readonly idempotencyKey?: string | undefined
    readonly meta?: Readonly<Record<string, string>> | undefined
  }

  export interface Reply {
    readonly k: 'reply'
    readonly cid: string
    readonly value: unknown

    /** output streams the owner pipes (`lane.<cid>.out.<name>`). */
    readonly outputs: readonly Plane[]

    /** what the owner's handler said about its HTTP reply (`ctx.reply`: a status, headers such
     * as `Location`) — the caller's edge applies it; absent when it said nothing (and from
     * older nodes). */
    readonly http?: HttpReply | undefined
  }

  /** A handler's `ctx.reply` as it crosses the wire. */
  export interface HttpReply {
    readonly status?: number | undefined
    readonly headers?: Readonly<Record<string, string>> | undefined
  }

  export interface Event {
    readonly k: 'event'

    /** minted per emitted envelope (`messaging.message.id` on the producer and consumer spans);
     * absent from pre-id nodes. */
    readonly id?: string | undefined
    readonly name: string
    readonly payload: unknown

    /** the emitting node's service id. */
    readonly origin: string

    /** the emitter's PRODUCER span (the consumer's `creation` link) + request id. */
    readonly trace?: Trace | undefined
  }

  export type Envelope = Dispatch | Reply | Event

  /**
   * The edge's HTTP failure body — `{ error: HttpFailure }`, flagged by the `oz-error` header
   * (the tag), written with the JsonCodec. No `_d`. `causes` keeps the failure's string causes
   * as plain strings (what a non-ozaco client reads); the failures it wraps appear among them
   * (JsonCodec-encoded, rebuilt into real Failures by a JsonCodec decode) only with
   * `createServer({ errors: { expose: 'chain' } })` or for a caller the node trusts
   * (`trace.trust(request) === true` — the self-asserted `tracestate` `ozaco=1` is not enough).
   * The same goes for the `remote: <operation> @ <service> span <id8>` causes a carrier hop adds
   * (node ids, span ids): kept in telemetry, left out of an untrusted caller's envelope.
   */
  export interface HttpFailure {
    /** the failure tag (`server.internal` for a thrown non-tag error). */
    readonly error: string
    readonly message: string
    readonly causes: readonly Result.Cause[]

    /** the HTTP status it was answered with. */
    readonly status: number
    readonly requestId: string

    /** the edge span's trace id — `''` when nothing was traced. */
    readonly traceId: string
  }
}
