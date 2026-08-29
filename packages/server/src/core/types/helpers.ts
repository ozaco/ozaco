import type { Flow, Operation, Queue, Scope, Task } from 'std:effect'

import type { RouterContext } from 'rou3'

import type { CarrierDef } from './carrier'
import type { EdgeDef } from './edge'
import type { ServerDef } from './server'
import type { ServiceDef } from './service'
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

  /** The per-request capture slot the edge fills while it runs the action. */
  export interface Captured {
    headers: Record<string, string> | null
    input: Record<string, unknown> | null
    output: Record<string, unknown> | null

    /** one entry per armed byte counter — settled when that body finished streaming. */
    readonly pending: Promise<void>[]
  }

  /** Build the handler context for one dispatch. */
  export interface ContextInput {
    readonly kernel: ServerDef.Context
    readonly call: ServerDef.Call
    readonly meta: ServiceDef.Meta
    readonly actions: Pick<ServerDef.Actions, 'call' | 'emit'>

    /** a principal decided BEFORE the dispatch (socket handshakes) — lands as `ctx.auth`. */
    readonly auth?: unknown
  }

  export interface Lane {
    readonly queue: Queue<Uint8Array, void>
    fed: boolean
    resume?: (() => void) | undefined
  }

  export interface SocketInput {
    readonly kernel: ServerDef.Context
    readonly route: EdgeDef.SocketRoute
    readonly raw: EdgeDef.RawSocket
    readonly params: Readonly<Record<string, string>>
    readonly headers: Readonly<Record<string, string>>
    readonly url: URL
    readonly ctx: ServerDef.Ctx
    readonly trace: TraceDef.Trace
  }

  /** A batching sink: rows collect in memory and leave in batches (by size or age). */
  export interface Sink<T> {
    /** queue one row (drops the oldest past `maxPending`). */
    push(row: T): void

    /** start the age timer in the current scope. */
    start(): Operation<void>

    /** send everything pending now. */
    flush(): Operation<void>
    readonly stats: { sent: number; dropped: number; failed: number }
  }

  export interface SinkOptions<T> {
    /** rows per batch. Default 200. */
    readonly size?: number | undefined

    /** max time a row waits. Default 1000. */
    readonly ms?: number | undefined

    /** rows held before the oldest are dropped. Default 10 000. */
    readonly maxPending?: number | undefined

    /** deliver one batch; a failure is counted, never raised. */
    readonly send: (rows: readonly T[]) => Operation<void>

    /** called once per failure STREAK (the first failed batch after a success) — surface
     * misconfiguration (wrong url, missing auth) without flooding. */
    readonly onError?: ((failure: unknown) => void) | undefined
  }

  /** One mounted action route. */
  export interface ActionRoute {
    readonly kind: 'action'
    readonly service: string
    readonly action: string
    readonly meta: ServiceDef.Meta
  }

  export interface RawRouteEntry {
    readonly kind: 'raw'
    readonly route: EdgeDef.RawRoute
  }

  export type Entry = ActionRoute | RawRouteEntry

  /** Per-install engine state (the Edge impl's context holds it). */
  export interface EdgeState {
    readonly kernel: ServerDef.Context
    readonly actions: Pick<ServerDef.Actions, 'call' | 'emit' | 'dispatch'>
    readonly router: RouterContext<Entry>
    readonly sockets: RouterContext<EdgeDef.SocketRoute>
    readonly decorators: EdgeDef.Decorator[]
    readonly scope: Scope
    preflight: EdgeDef.Preflight | null
    paused: boolean
    mounted: boolean
    info: EdgeDef.ListenInfo | null
  }

  export interface ActionCall {
    readonly state: EdgeState
    readonly request: Request
    readonly entry: ActionRoute
    readonly params: Readonly<Record<string, string>>
    readonly trace: TraceDef.Trace

    /** filled while the action runs (only when an observer is installed). */
    readonly captured: Helpers.Captured
  }

  export interface Finish {
    readonly state: EdgeState
    readonly request: Request
    readonly response: Response
    readonly requestId: string
  }
}
