import type { Flow, Operation, Task } from 'std:effect'

import type { CarrierDef } from './carrier'
import type { ServerDef } from './server'
import type { TraceDef } from './trace'

/** Internal helper shapes the core passes around — collected here so no type lives outside
 * `types/`. */
export namespace Helpers {
  /** A dispatch in flight on this node. */
  export interface Inflight {
    readonly cid: string
    readonly task: Task<unknown>
    readonly controller: AbortController
  }

  /** What the kernel needs to run one dispatch end to end. */
  export interface DispatchInput {
    readonly call: ServerDef.Call
    readonly trace: TraceDef.Trace
  }

  /** One open span while it runs. */
  export interface OpenSpan {
    readonly trace: TraceDef.Trace
    readonly kind: TraceDef.SpanKind
    readonly name: string
    readonly actionId: string | null
    readonly transport: string | null
    readonly startedAt: number
    attrs: Record<string, unknown> | null
  }

  export type Thunk<T> = () => Operation<T>

  /** The node's own lifecycle state: what `start()`/`stop()` move and `info()`/`health()` read. */
  export interface NodeState {
    readonly role: ServerDef.Role
    readonly hosted: readonly string[]
    readonly options: ServerDef.Options
    url: string | null
    port: number | null
    started: boolean
    ready: boolean
  }

  /** The memory outcome store's state. */
  export interface OutcomesMemoryState {
    readonly rows: Map<string, TraceDef.Outcome>
    readonly ttlMs: number
  }

  /** The db outcome store's state. */
  export interface OutcomesDbState {
    readonly ttlMs: number
  }

  /** The local carrier's state: the services served in-process. */
  export interface LocalCarrierState {
    readonly served: Map<string, CarrierDef.Server>
  }

  /** One local dispatch with a deadline, as `callLocal` takes it. */
  export interface LocalCall {
    readonly kernel: ServerDef.Context
    readonly trace: TraceDef.Trace
    readonly service: string
    readonly action: string
    readonly input: unknown
    readonly headers: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly idempotencyKey: string | undefined
    readonly transport: string

    readonly actions: Pick<ServerDef.Actions, 'call' | 'emit'> & {
      readonly outcome: (outcome: TraceDef.Outcome) => Operation<void>
    }
  }

  /** A call leaving over the carrier. */
  export interface RemoteCall {
    readonly trace: TraceDef.Trace
    readonly service: string
    readonly action: string
    readonly input: unknown
    readonly deadline: number
    readonly idempotencyKey: string | undefined
    readonly meta: Readonly<Record<string, string>> | undefined
  }

  /** A call from outside any dispatch, run as a request of its own. */
  export interface RootCall<T> {
    readonly kernel: ServerDef.Context
    readonly trace: TraceDef.Trace
    readonly target: { readonly service: string; readonly action: string }
    readonly body: () => Operation<T>
  }

  /** What `withSpan` needs to open one span. */
  export interface SpanInput {
    readonly kernel: ServerDef.Context
    readonly trace: TraceDef.Trace
    readonly kind: TraceDef.SpanKind
    readonly name: string
    readonly actionId?: string | undefined
    readonly transport?: string | undefined
    readonly attrs?: Record<string, unknown> | undefined
  }

  /** A stream output the handler produced as a Flow: materialized into a branded stream by the
   * CONSUMER'S scope (the dispatch task ends before the stream is read). */

  export interface DeferredStream {
    readonly _t: 'deferred-stream'
    readonly flow: Flow<unknown, unknown>
    readonly brand: string
  }
}
