import type { Flow, Operation } from 'std:effect'
import type { Result } from 'std:result'

import type { TransportDef } from './transport'

/** Internal helper shapes the core passes around — collected here so no type lives outside
 * `types/`. */
export namespace Helpers {
  /** A lane frame as decoded from a raw message. */
  export type Frame =
    | { readonly kind: 'data'; readonly seq: number; readonly raw: TransportDef.Raw }
    | { readonly kind: 'chunk'; readonly seq: number; readonly raw: TransportDef.Raw }
    | { readonly kind: 'end'; readonly seq: number; readonly raw: TransportDef.Raw }
    | { readonly kind: 'fail'; readonly seq: number; readonly raw: TransportDef.Raw }

  /** The credit a lane consumer grants: how many more frames the producer may send. */
  export interface Credit {
    readonly n: number
  }

  /** A credit frame as the producer reads it off the wire. */
  export interface CreditFrame extends Credit {
    /** true for the repeated attach announcements; a producer honours only the first of those. */
    readonly initial: boolean
  }

  /** The producer side of one lane: how frames leave. */
  export interface Producer {
    /** Publish one value frame (raw `Uint8Array` → `chunk`). */
    send(value: unknown): Operation<void>
    /** Publish the terminal frame with the close value. */
    end(close: unknown): Operation<void>
    /** Publish a terminal failure frame. */
    abort(failure: Result.Failure<unknown>): Operation<void>
    /** Scope teardown: if no terminal frame went out (the producer was halted mid-lane), tell
     * the consumer the lane died instead of leaving it waiting forever. Best-effort. */
    leave(): Operation<void>
  }

  /** One chunked payload being reassembled on the receiving side. */
  export interface Assembly {
    readonly parts: (Uint8Array | undefined)[]
    readonly headers: TransportDef.Headers
    readonly topic: string
    readonly seq: string | undefined
    received: number
    readonly startedAt: number
  }

  /** What the plane factory works with — the driver plus the resolved lane defaults. */
  export interface Runtime {
    readonly driver: TransportDef.Driver
  }

  /** One request as the package plane receives it. */
  export interface Request<TArgs> {
    readonly topic: string
    readonly args: TArgs
    readonly options?: TransportDef.RequestOptions | undefined
  }

  /** One served topic as the package plane receives it (`group` already namespaced). */
  export interface Service<TArgs, TResult> {
    readonly topic: string
    readonly handler: TransportDef.Handler<TArgs, TResult>
    readonly group?: string | undefined
  }

  /** One lane publication as the flow plane receives it. */
  export interface Pipe<T, TClose> {
    readonly topic: string
    readonly source: Flow<T, TClose>
    readonly options?: TransportDef.LaneOptions | undefined
  }

  /** The parsed outcome of a reply message. */
  export type Reply<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly failure: Result.Failure<unknown> }

  export interface WriteCommand {
    readonly chunk: Uint8Array | null
    readonly failure: Result.Failure<unknown> | null
    readonly settle: (outcome: Result.Failure<unknown> | null) => void
  }
}
