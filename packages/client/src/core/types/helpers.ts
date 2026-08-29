import type { ClientDef } from './client'
import type { ManifestDef } from './manifest'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface Prepared {
    readonly url: string
    readonly init: RequestInit
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
    | { readonly t: 'error'; readonly tag: string; readonly message: string }

  /** The hooks a pager wires into a watch: page turns in, pager info out. */
  export interface WatchHooks {
    readonly register?:
      | ((turn: (cursor: string | null, back?: boolean) => void) => void)
      | undefined
    readonly onPage?: ((page: ClientDef.WindowInfo | null) => void) | undefined
  }

  /** A failure as an app renders it — the wire fields plus what the causes carry. */
  export interface WireFailure {
    readonly tag: string
    readonly message: string
    readonly causes: readonly string[]

    /** parsed from the `status:<code>` cause the client appends to HTTP failures. */
    readonly status: number | null

    /** parsed from the `req:<id>` cause. */
    readonly requestId: string | null
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
