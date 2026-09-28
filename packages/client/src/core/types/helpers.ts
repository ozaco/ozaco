import type { Scope } from 'std:effect'
import type { TraceDef } from 'std:trace'

import type { ClientDef } from './client'
import type { ManifestDef } from './manifest'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface Prepared {
    readonly url: string
    readonly init: RequestInit
  }

  /**
   * One HTTP exchange's CLIENT span as the call hands it on: `live` until it ends (then dropped —
   * a long-lived scope keeps a spent holder, never the span), the scope it started in (its Trace sinks
   * is visible there: an end from anywhere else runs in it), when the reply's headers arrived (a
   * body never consumed ends the span at that time) and whether a streamed body is being
   * consumed (left mid-way, the span ends cancelled).
   */
  export interface CallSpan {
    live: TraceDef.LiveSpan | null
    readonly context: TraceDef.SpanContext
    /** whether `context` names a span (a no-op span's does not). */
    readonly valid: boolean
    readonly recording: boolean
    readonly scope: Scope
    headersAt: number | undefined
    consuming: boolean
  }

  /** How a held byte stream settled: fully read (`{}`), failed (`error`) or `cancelled`. */
  export interface HeldOutcome {
    readonly error?: unknown
    readonly cancelled?: boolean
  }

  /** What a held byte stream reports: its first read, and how it settled (once). */
  export interface HeldHooks {
    readonly start?: (() => void) | undefined
    readonly settle?: ((outcome: HeldOutcome) => void) | undefined
  }

  /** One call's ingredients. */
  export interface CallInput {
    readonly ctx: ClientDef.Context
    readonly action: ManifestDef.Action
    readonly input: unknown
    readonly options?: ClientDef.CallOptions | undefined
  }

  export type Frame =
    | ClientDef.WatchFrame
    | {
        readonly t: 'error'
        readonly tag: string
        readonly message: string

        /** the `traceparent` of the span that recorded the failure, when the server did (the
         * wire's `recorded` marker): in the trace the watch was sent in, the client's spans
         * only carry its status — the exception is the server's. */
        readonly recorded?: string | undefined
      }

  /** The hooks a pager wires into a watch: page turns in, pager info out. */
  export interface WatchHooks {
    readonly register?:
      | ((turn: (cursor: string | null, back?: boolean) => void) => void)
      | undefined
    readonly onPage?: ((page: ClientDef.WindowInfo | null) => void) | undefined
  }

  /** A failure as an app renders it — the wire fields plus what the causes carry (a nested
   * failure cause as its one-line `formatFailure`). */
  export interface WireFailure {
    readonly tag: string
    readonly message: string
    readonly causes: readonly string[]

    /** parsed from the `status:<code>` cause the client appends to HTTP failures. */
    readonly status: number | null

    /** parsed from the `req:<id>` cause. */
    readonly requestId: string | null
  }

  /** The `{ error }` envelope of an ozaco failure reply, read defensively (it is untrusted JSON). */
  export interface Envelope {
    readonly error?: unknown
    readonly message?: unknown
    readonly causes?: unknown
    readonly traceId?: unknown
  }

  /**
   * The ozaco call a failed reply answers, as its decoder knows it: named in the decoded
   * failure's `remote: <operation> @ <service> span <id8>` cause; `recordedIn` — the trace (the
   * caller's own) the sender recorded the failure in: it is marked recorded there as a remote
   * one, so the caller's spans carry only its status and the exception stays the sender's.
   */
  export interface Remote {
    readonly operation?: string | undefined
    readonly service?: string | undefined
    readonly recordedIn?: string | undefined
  }

  /** Any handle (typed or not), or `connectClient`'s promise of one — only the statics are used. */
  export type HandleLike = ClientDef.Statics | Promise<ClientDef.Statics>

  export interface SendRequest {
    readonly service: string
    readonly action: string
    readonly input?: unknown
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly timeoutMs?: number | undefined
  }

  /** One step of a streamed reply, stamped with the elapsed ms — a timeline renders these. */
  export type Chunk =
    | { readonly kind: 'value'; readonly value: unknown; readonly at: number }
    | { readonly kind: 'text'; readonly text: string; readonly at: number }
    | { readonly kind: 'bytes'; readonly size: number; readonly at: number }

  export interface Outcome {
    readonly ok: boolean
    readonly status: number | null
    readonly requestId: string | null
    readonly brand: string | null
    readonly elapsedMs: number

    /** a value / text answer, or the bytes collected. */
    readonly value: unknown
    readonly bytes: Uint8Array | null
    readonly error: WireFailure | null
    readonly streamed: boolean
  }

  export interface InFlight {
    readonly done: Promise<Outcome>
    cancel(): Promise<void>
  }

  export interface WatchHandlers<TRow = unknown> {
    readonly onFrame: (frame: ClientDef.WatchFrame<TRow>) => void
    readonly onEnd?: ((error: WireFailure | null) => void) | undefined
  }

  export interface Watching {
    stop(): Promise<void>

    /** Windowed watches: turn THIS subscription's page — same socket, no reconnect. */
    turn(cursor: string | null, back?: boolean): void
  }

  /** One openable thing in the sidebar. */
  export type Entry =
    | { readonly kind: 'action'; readonly id: string; readonly action: ManifestDef.Action }
    | { readonly kind: 'socket'; readonly id: string; readonly socket: ManifestDef.Socket }

  export interface ServiceGroup {
    readonly name: string
    readonly version: string
    readonly description: string | undefined
    readonly entries: readonly Entry[]
  }

  /**
   * JSON Schema (what the manifest carries per plane) → an example value, a flat field list and
   * text coercion — what any tool that builds a call or a form from the manifest needs (the docs
   * panel's Params form, a CLI try-it, tests). Small on purpose: objects, arrays, primitives,
   * enums, unions, defaults.
   */
  export type Schema = Record<string, unknown> | null | undefined

  export interface Field {
    readonly name: string
    readonly type: string
    readonly required: boolean
    readonly description: string | undefined
    readonly options: readonly unknown[] | null
  }
}
