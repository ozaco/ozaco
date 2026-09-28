import type { Flow, Operation, Queue, Scope, Task } from 'std:effect'
import type { Result } from 'std:result'
import type { TraceDef } from 'std:trace'

import type { RouterContext } from 'rou3'

import type { CarrierDef } from './carrier'
import type { EdgeDef } from './edge'
import type { OptionsDef } from './options'
import type { OutcomesDef } from './outcomes'
import type { ServerDef } from './server'
import type { ServiceDef } from './service'

/** Internal helper shapes the core passes around — collected here so no type lives outside
 * `types/`. */
export namespace Helpers {
  /** A dispatch in flight on this node. */
  export interface Inflight {
    readonly cid: string
    readonly task: Task<unknown>
    readonly controller: AbortController
  }

  /** A span body (what `std:trace` `span()` runs). */
  export type SpanBody<T> = (span: TraceDef.SpanHandle) => Operation<T>

  /** What `withDispatchSpan` needs to open the span of one dispatch. */
  export interface DispatchSpanInput {
    readonly kernel: ServerDef.Context
    readonly call: ServerDef.Call

    /** the action's resolved meta (its `errors` classify the failure) — `null` when the action
     * is unknown here (a SERVER span is then named `ozaco`, `rpc.method` `_OTHER`). */
    readonly meta: ServiceDef.Meta | null

    /** Default: `'server'` when `call.parent` is a remote context (received over a carrier),
     * else `'internal'`. Pass `'internal'` for a same-process carrier hop (no CLIENT/SERVER
     * self-loop in the service graph). */
    readonly kind?: 'internal' | 'server' | undefined
  }

  /** What `carrierSpan` needs to open the caller-side CLIENT span of a carrier call. */
  export interface CarrierSpanInput {
    readonly service: string
    readonly action: string

    /** the callee's declared `errors` (status classifier), when this node knows its meta. */
    readonly meta?: Pick<ServiceDef.Meta, 'errors'> | undefined
  }

  /** What `edgeSpan` needs to open the SERVER span of one HTTP request / WS upgrade. */
  export interface EdgeSpanInput {
    readonly kernel: ServerDef.Context
    readonly request: Request
    readonly url: URL

    /** the matched route TEMPLATE (`/todos/:id`, a raw route's path, a socket route's path);
     * `null` when nothing matched (the span is then named `{METHOD}`). */
    readonly route: string | null

    /** the route's record mode — plugin-owned services/routes pass `'errors'`. Default `'on'`. */
    readonly observe?: EdgeDef.Observe | undefined
  }

  /** An opened edge span (see `edgeSpan`). */
  export interface EdgeSpan {
    /** the SERVER span, ended by the edge when the response BODY is done (idle — `run` just runs
     * and `end` does nothing — when tracing is off or the route's `observe` is `'off'`). */
    readonly span: TraceDef.LiveSpan

    /** the request id (§6.1): a valid inbound `x-request-id`, else the trace id minted here,
     * else a fresh id. */
    readonly requestId: string

    /** the valid inbound context (`traceparent` / `tracestate`), whatever the mode. */
    readonly inbound: TraceDef.SpanContext | null

    /** whether the node TRUSTS the caller (`trace.trust(request) === true`): its sampled flag
     * is honoured (its WS frames' too) and a failed reply carries the nested cause chain. */
    readonly trusted: boolean

    /** whether the caller marked itself an observing ozaco caller (`tracestate` `ozaco=1`) —
     * self-asserted: its trace is CONTINUED (its WS frames' too), but its sampled flag is never
     * honoured and it gets no cause chain. */
    readonly marked: boolean

    /** the inbound context this request runs under as a PASS-THROUGH (tracing off here and the
     * context continued — as it would be continued); `null` otherwise. */
    readonly passing: TraceDef.SpanContext | null

    /** Run `body` with the span active — or, when it is idle, with the {@link passing} context as
     * a PASS-THROUGH (propagation survives a non-observing node); suppressed for `'off'`. */
    run<T>(body: SpanBody<T>): Operation<T>
  }

  /** How a failure was answered (`replyFailure`). */
  export interface ReplyOptions {
    /** the status it was answered with (`statusOf(f, meta)` at the edge). */
    readonly status: number

    /** the exception `eventName` when it is recorded on the answering span itself (it never
     * escaped a span here). Default `http.server.request.exception`. */
    readonly eventName?: string | undefined
  }

  /** How an inbound context shapes an edge span (`inboundOf`). */
  export interface Inbound {
    /** `null` ⇒ a new root; a context ⇒ continued (a `marked`-only caller's with the sampled
     * bit set — its flag is not honoured). */
    readonly parent: TraceDef.SpanContext | null
    readonly links: readonly TraceDef.LinkInput[]

    /** `trace.trust(request) === true`: the sampled flag is honoured, the chain exposed. */
    readonly trusted: boolean

    /** `ozaco=1` in the inbound `tracestate` (or marked before): continued, nothing more. */
    readonly marked: boolean

    /** the effective mode (`continue` when trusted or marked). */
    readonly mode: ServerDef.TraceSettings['inbound']
  }

  export type Thunk<T> = () => Operation<T>

  /** What `createServer` hands on once the kernel and its tracer are in. */
  export interface NodeBuild {
    readonly role: ServerDef.Role
    readonly hosted: readonly string[]
    readonly kernel: ServerDef.Context
    readonly tracer: ServerDef.TracerContext

    /** a non-server Trace sink was enabled around the node: it observes. */
    readonly traced: boolean

    /** stop holding the node's boot records (`bootLogs`; idempotent). */
    readonly unboot: () => void
  }

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
    readonly rows: Map<string, OutcomesDef.Outcome>
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
    readonly cid: string
    readonly requestId: string
    readonly origin: ServerDef.Origin
    readonly service: string
    readonly action: string
    readonly input: unknown
    readonly headers: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly idempotencyKey: string | undefined
    readonly transport: string

    readonly actions: Pick<ServerDef.Actions, 'call' | 'emit'> & {
      readonly outcome: (outcome: OutcomesDef.Outcome) => Operation<void>
    }
  }

  /** What `runDispatch` runs a call with: the kernel actions a handler reaches, and where to write
   * the id of the span the dispatch runs in once it is known (`callLocal`'s `local` breadcrumb). */
  export interface DispatchWith {
    readonly actions: Pick<ServerDef.Actions, 'call' | 'emit'>
    readonly seen?: { spanId: string }
  }

  /** A call leaving over the carrier (the wire trace is injected inside its CLIENT span). */
  export interface RemoteCall {
    readonly cid: string
    readonly requestId: string
    readonly service: string
    readonly action: string
    readonly input: unknown
    readonly deadline: number
    readonly idempotencyKey: string | undefined
    readonly meta: Readonly<Record<string, string>> | undefined

    /** the edge's `ctx.reply` sink (a gateway forwarding an edge call): the owner's reply
     * status / headers are handed to it. */
    readonly reply?: ((reply: ServerDef.Reply) => void) | undefined
  }

  /** A call from outside any dispatch, run as a request of its own (`RequestRef` set). */
  export interface RootCall<T> {
    readonly kernel: ServerDef.Context
    readonly request: ServerDef.ActiveRequest
    readonly target: { readonly service: string; readonly action: string }
    readonly body: () => Operation<T>
  }

  /** A stream output the handler produced as a Flow: materialized into a branded stream by the
   * CONSUMER'S scope (the dispatch task ends before the stream is read). */

  export interface DeferredStream {
    readonly _t: 'deferred-stream'
    readonly flow: Flow<unknown, unknown>
    readonly brand: string
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

  /** What `contextFor` (dispatch.ts) takes to build a handler context OUTSIDE a dispatch
   * (socket routes): `ctx.spanId` / `ctx.trace` are the span ACTIVE when it is called;
   * `ctx.log` / `ctx.span` / `ctx.event` / `ctx.call` follow the active span at each call. */
  export interface ContextForInput {
    /** the route (`ctx.action`). */
    readonly name: string

    /** the service that declared the socket (`ctx.service`); `$edge` for a route of the edge's
     * own (`Edge.actions.socket`). */
    readonly service?: string | undefined
    readonly requestId: string
    readonly origin: ServerDef.Origin
    readonly headers: Readonly<Record<string, string>>
    readonly signal: AbortSignal

    /** the handshake's verified principal (socket routes) — lands as `ctx.auth`. */
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
    readonly requestId: string

    /** the upgrade span's context — every per-frame root span LINKS it (`ws.session`), the
     * close log is correlated to it. `null` when nothing was traced. */
    readonly upgrade: TraceDef.SpanContext | null

    /** the node trusts the upgrade request (`trace.trust`): a frame's `traceparent` is its
     * parent, sampled flag honoured. */
    readonly trusted: boolean

    /** the upgrade came from a self-marked ozaco caller (`ozaco=1`): a frame's `traceparent` is
     * its parent, but always recorded here (its sampled flag is not honoured). */
    readonly marked: boolean
    readonly signal: AbortSignal
    readonly actions: Pick<ServerDef.Actions, 'call' | 'emit'>
    readonly request: Request

    /** header-authorized (or open) → the settled principal; deferred → the socket waits for
     * the first `{ t: 'auth' }` frame and authorizes then. */
    readonly auth:
      | { readonly kind: 'settled'; readonly principal: unknown }
      | { readonly kind: 'deferred' }
  }

  /** A batching sink: rows collect in memory and leave in batches (by size or age). */
  export interface Sink<T> {
    /** queue one row (drops the oldest past `maxPending`). */
    push(row: T): void

    /** start the age timer in the current scope. */
    start(): Operation<void>

    /** wait for a send already in flight, then send everything pending now. */
    flush(): Operation<void>
    readonly stats: { sent: number; dropped: number; failed: number }
  }

  export interface SinkOptions<T> {
    /** rows per batch — a full batch leaves at once (a partial one waits for the next beat).
     * Default 200. */
    readonly size?: number | undefined

    /** longest a row waits before its batch is sent. Default 1000. */
    readonly waitMs?: number | undefined

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

    /** the routing tables — REPLACED as a whole by `remount` (a request reads them once). */
    router: RouterContext<Entry>
    sockets: RouterContext<EdgeDef.SocketRoute>

    /** what was registered through `raw()` / `socket()` — re-added on every remount. */
    readonly raws: EdgeDef.RawRoute[]
    readonly socketRoutes: EdgeDef.SocketRoute[]
    readonly decorators: EdgeDef.Decorator[]
    readonly scope: Scope
    preflight: EdgeDef.Preflight | null
    paused: boolean
    mounted: boolean
    info: EdgeDef.ListenInfo | null
  }

  export interface Finish {
    readonly state: EdgeState
    readonly request: Request
    readonly response: Response
    readonly requestId: string

    /** the edge span — `traceresponse` is its context. */
    readonly span: TraceDef.SpanHandle

    /** the failure it answers (an `errors`-mode success clears the sampled bit). */
    readonly failure?: Result.Failure<unknown> | null | undefined
  }

  /** One inbound frame as it arrived: the decoded value, its text, its size in bytes, when. */
  export interface InboundFrame {
    readonly value: unknown
    readonly text: string
    readonly size: number
    /** when it arrived, on the MONOTONIC clock (`performance.now()`) — its span starts there, on
     * the trace clock (`startOf`): sub-millisecond, so frames keep their arrival order. */
    readonly at: number
  }

  /** A socket session's counters — what the close log reports. */
  export interface SocketSession {
    readonly id: string
    readonly openedAt: number
    received: number
    sent: number
    code: number | null
    reason: string
  }

  /** What a `WS {route}` span is opened for: the frame (`null` for a session event that is no
   * frame) and its record mode (`'errors'`: kept only when it fails). */
  export interface FrameOpening {
    readonly frame: InboundFrame | null
    readonly record?: 'always' | 'errors' | undefined
  }

  /** The frame span the handler works under: active in the scope that pulled the frame. */
  export interface HeldFrame {
    readonly live: TraceDef.LiveSpan
    /** gives the handler's scope back what was active before the frame span. */
    readonly restore: () => void

    /** ends the frame span once released, a tick later (see `release`). */
    readonly later: ReleasedFrames
  }

  /** The released frame spans of one socket, ended a scheduler tick after their release. */
  export interface ReleasedFrames {
    /** end `live` a tick from now (`true`), or `false` when it cannot any more (end it now). */
    defer(live: TraceDef.LiveSpan, end: TraceDef.EndOptions): boolean

    /** end every span still waiting, now — the socket's own teardown, so none is lost. */
    flush(): Operation<void>
  }

  /**
   * What one request path answered: the response BEFORE the decorators, the failure it carries
   * (`null` on success), whether its body STREAMS (the edge span then ends with the body) and — for
   * a crash turned into a 500 — the failure the span ends with.
   */
  export interface EdgeAnswer {
    readonly response: Response
    readonly failure: Result.Failure<unknown> | null
    readonly streamed: boolean
    readonly fault?: Result.Failure<unknown> | undefined

    /** the failure a streamed body's source broke with while the body still ended cleanly (an
     * sse feed), read once the body is done. */
    readonly broke?: (() => Result.Failure<unknown> | null) | undefined
  }

  /** What `upgradeOf` decides: accept (the engine's own `attach`, wrapped into the driver's
   * {@link EdgeDef.Accepted} by `decideUpgrade`) or reject. */
  export type UpgradeDecision =
    | { readonly kind: 'accept'; readonly attach: (socket: EdgeDef.RawSocket) => void }
    | Extract<EdgeDef.Upgrade, { kind: 'reject' }>

  /** A request being answered INSIDE its edge span. */
  export interface Answering {
    readonly state: EdgeState
    readonly request: Request
    readonly url: URL
    readonly edge: EdgeSpan
    readonly handle: TraceDef.SpanHandle

    /** how much the edge span records (`observeOf`): what its `traceresponse` may advertise. */
    readonly observe: EdgeDef.Observe
  }

  /** What `finish` stamps a response with, besides the ids. */
  export interface Finishing extends Finish {
    readonly observe: EdgeDef.Observe
  }

  /** A request answered by `serveRequest`: its response, and `done` — settled once the body is
   * finished (a streamed one: read to its end, failed or cancelled) and the edge span has ended. */
  export interface ServedRequest {
    readonly response: Response
    readonly done: Promise<void>
  }

  /** How the runtime upgrade of an accepted request went, as the driver reported it. */
  export type UpgradeOutcome =
    | { readonly t: 'upgraded' }
    | { readonly t: 'failed'; readonly reason: unknown; readonly status: number }
    | { readonly t: 'unknown' }

  /** What shapes a successful reply besides its value: the action's static `status`/`headers`
   * with the handler's `ctx.reply` merged over them. */
  export interface ReplyShape {
    readonly status?: number | null | undefined
    readonly headers?: Readonly<Record<string, string>> | undefined

    /** called once when a value stream's source FAILS after the headers went out and the body
     * ends cleanly anyway (sse) — the failure must still reach the edge span. */
    readonly broke?: ((reason: unknown) => void) | undefined
  }

  /** How a failed reply is rendered (`failureResponse`). */
  export interface FailureShape {
    readonly requestId: string

    /** the edge span's trace id (`''` when nothing was traced). */
    readonly traceId: string

    /** the action's `errors` map (its status overrides). */
    readonly meta?: Pick<ServiceDef.Meta, 'errors'> | undefined

    /** carry the nested cause chain (`errors.expose === 'chain'`, or a trusted ozaco caller). */
    readonly chain: boolean

    /** where the envelope is written — the edge's own `JsonCodec` scope (`jsonScope`). */
    readonly json: Scope | null
  }

  /** One parsed `call(...)`: the target coordinates plus the (input, options) tail. */
  export interface ParsedCall {
    readonly service: string
    readonly action: string
    readonly input: unknown
    readonly options: ServerDef.CallOptions | undefined
  }

  /** The keys of an action config that are STRUCTURAL (everything else on it is a plugin
   * option) — what `STRUCTURAL` (core/internal/service.ts) is pinned to at compile time. */
  export type StructuralKey = Exclude<keyof ServiceDef.Config, keyof OptionsDef.ActionOptions>

  /** The structural keys a tuple of them leaves out (`never` once it names them all). */
  export type MissingStructural<T extends readonly string[]> = Exclude<StructuralKey, T[number]>
}
