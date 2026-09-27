import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

import type { SpanRecorder } from '../internal/recorder'

import type { TraceDef } from './trace'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  /** A span body. */
  export type Body<T> = (span: TraceDef.SpanHandle) => Operation<T>

  /** The wall/monotonic pair a local root anchors its clock to. */
  export interface Anchor {
    readonly wall: number
    readonly mono: number
  }

  /** How a span ended. */
  export type Outcome =
    | { readonly t: 'ok' }
    | { readonly t: 'failed'; readonly failure: Result.Failure<unknown> }
    | { readonly t: 'halted' }

  /**
   * A failure parked on its local trace until it SETTLES (hold-until-settled): the spans it
   * escaped wait for its final state, the exception is recorded once at `origin`.
   */
  export interface Pending {
    readonly failure: Result.Failure<unknown>
    /** The first span the failure escaped (or the absorbed inner failure's origin). */
    readonly origin: SpanRecorder
    /** When it failed, clamped into the origin span. */
    readonly time: number
    /** The origin's `failure.eventName`. */
    readonly eventName: string | undefined
    /** Every span the failure escaped, inner → outer. */
    readonly held: SpanRecorder[]
    /** Spans halted while it was pending below them — unwound BY it when it keeps propagating (a
     * crashed child task halts its parents' frames first), plain cancellations when it was handled. */
    readonly unwound: SpanRecorder[]
    /** Inner failures this one wraps (their spans take the settled status, no own exception). */
    readonly absorbed: Pending[]
    /** The outermost classifiers seen so far. */
    status: ((failure: Result.Failure<unknown>) => number) | undefined
    type: ((failure: Result.Failure<unknown>) => string) | undefined
    handledSeverity: number | undefined
  }

  export interface SettleHow {
    /** The failure never escaped an ancestor that still ran on: it was dealt with. */
    readonly handled?: boolean
    /** The status the failure was answered with. */
    readonly status?: number | undefined
  }

  /** What was recorded where: the objects a failure is known by → the trace ids it was recorded
   * in (the newest last). */
  export type Registry = WeakMap<object, Set<string>>

  /** The process-level fallback queue — the first sink receives. */
  export type Sinks = readonly TraceDef.FallbackSink[]

  /** How one exception is recorded: its severity, event name and time. */
  export interface RecordHow {
    readonly severity: number
    readonly eventName: string
    readonly time: number
  }

  /** A settled failure's verdict for the spans it escaped. */
  export interface Verdict {
    readonly code: number
    readonly type: string
    /** It never failed what ran on: retried, replaced by a fallback, caught. */
    readonly handled: boolean
  }

  /** What a recorder is built from. */
  export interface RecorderInit {
    readonly name: string
    readonly context: TraceDef.SpanContext
    readonly parent: TraceDef.SpanContext | null
    readonly local: SpanRecorder | null
    readonly kind: TraceDef.SpanKind
    readonly scope: TraceDef.InstrumentationScope
    readonly service: string | null
    readonly recording: boolean
    readonly start: number
    readonly failure: TraceDef.FailureOptions | undefined
    /** A token of the scope (task) the span was opened in — `null` for a pass-through. */
    readonly opener: object | null
  }
}
