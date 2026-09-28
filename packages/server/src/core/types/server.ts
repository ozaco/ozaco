import type { Flow, Operation, Scope } from 'std:effect'
import type { EventEmitter } from 'std:event'
import type { Plugin } from 'std:plugin'
import type { AnyType, StandardSchemaV1 } from 'std:shared'
import type { TraceDef } from 'std:trace'

import type { CarrierDef } from './carrier'
import type { EdgeDef } from './edge'
import type { ObserveDef } from './observe'
import type { OptionsDef } from './options'
import type { OutcomesDef } from './outcomes'
import type { ServiceDef } from './service'
import type { WireDef } from './wire'

/**
 * The kernel: what `createServer` installs and what every other layer (edge, carriers, plugins)
 * talks to. ONE mental model: service → action → dispatch.
 */
export namespace ServerDef {
  // --- install ------------------------------------------------------------------------------

  /**
   * What `createServer` installs: a plugin's `use(...args)` operation (arguments bound,
   * the handle travelling with it) — or a bare handle when it takes no arguments.
   */
  export type PluginLike = Plugin<AnyType, AnyType[], AnyType> | Plugin.Use<AnyType, AnyType[]>

  /** What this node is. `monolith`: every service + the edge in one process. `gateway`: the edge
   * only, every call forwarded over the carrier. `service`: hosted services, no edge (unless one
   * is given, for health). */
  export type Role = 'monolith' | 'gateway' | 'service'

  export interface Options<
    TServices extends readonly ServiceDef.Service[] = readonly ServiceDef.Service[],
  > {
    readonly services: TServices

    /** The edge runtime (an `Edge` impl plugin). Omit for a headless node (carrier only). */
    readonly edge?: PluginLike | undefined

    /** The cross-node carrier (a `Carrier` impl plugin). Omit for a single process
     * (`LocalCarrier`). */
    readonly carrier?: PluginLike | undefined

    /** Plugins, installed in order — their `around.dispatch` hooks wrap in that order. */
    readonly plugins?: readonly PluginLike[] | undefined

    /** This instance's id (`name@version#instance`). Default: random. */
    readonly instance?: string | undefined

    /** The application name every service id and topic carries. Default `'app'`. */
    readonly name?: string | undefined
    readonly version?: string | undefined

    /** Default per-call deadline. Default 30 000. */
    readonly timeoutMs?: number | undefined

    /** What this node is. Default: `process.env.SERVICE ? 'service' : 'monolith'`. */
    readonly role?: Role | undefined

    /** Which of the declared services THIS node hosts (the rest are reached over the carrier).
     * Default: `process.env.SERVICE` split on commas on a `service` node, `[]` on a gateway,
     * every declared service otherwise. */
    readonly hosted?: readonly string[] | undefined

    /** Where to listen, when an edge is installed. */
    readonly listen?: ListenOptions | undefined

    /** health endpoint path on the edge. Default `/_health`; `false` disables it. */
    readonly health?: string | false | undefined

    /** Services that must have a live member before `start()` resolves (health reports
     * `ready: false` / 503 meanwhile). Default by role: `service` nodes wait for nobody (they
     * start at once, so a sequential rollout's first pod comes up); gateway/monolith wait for
     * every declared service they do not host. `[]` = start at once. */
    readonly dependsOn?: readonly string[] | undefined

    /** How long `start()` waits for `dependsOn`; past it `start()` fails `server.unavailable`.
     * Default 30 000. */
    readonly readyTimeoutMs?: number | undefined

    /** How long `stop()` lets the paused edge answer 503 before it starts draining. Default 50. */
    readonly pauseMs?: number | undefined

    /** How long `stop()` waits for in-flight dispatches after leaving the cluster. Default 5000. */
    readonly drainMs?: number | undefined

    /** How inbound trace context is used at the edge, and whether responses carry it back. */
    readonly trace?: TraceOptions | undefined

    /** What this node's telemetry says about itself (`service.name`, namespace, environment)
     * and what it captures (headers, bodies, frames, `enduser.id`) — decided ONCE, here. */
    readonly observe?: ObserveOptions | undefined

    /** What a failed edge reply exposes. */
    readonly errors?: ErrorOptions | undefined
  }

  /** `createServer({ trace })`. */
  export interface TraceOptions {
    /**
     * What an inbound HTTP/WS `traceparent` does to the edge span. `'link'` (default): a new
     * root, sampled by local policy, LINKING the inbound context (`ozaco.link.reason =
     * 'remote.parent'`; inbound flags ignored). `'continue'`: the inbound context is the parent
     * (its sampled flag honoured). `'ignore'`: a new root, no link. A request `trust` accepts is
     * always continued, its sampled flag honoured. A request whose `tracestate` carries `ozaco=1`
     * (an observing ozaco client / std fetch) is continued too — traces between ozaco nodes stay
     * one trace — but the marker is self-asserted: its sampled flag is NOT honoured (a `-00` is
     * still recorded, and forwarded sampled) and it gets no cause chain. Carriers ALWAYS
     * continue, flags honoured.
     */
    readonly inbound?: 'link' | 'continue' | 'ignore' | undefined

    /** Requests this node TRUSTS (an internal proxy, a trusted gateway): their inbound context is
     * continued whatever `inbound` says, their sampled flag honoured, and a failed reply carries
     * the nested cause chain. Only `true` trusts; a throwing predicate trusts nobody. */
    readonly trust?: ((request: Request) => boolean) | undefined

    /** Answer with `traceresponse` (W3C draft) + `x-request-id`. Default `true`. */
    readonly response?: boolean | undefined
  }

  /** `createServer({ observe })`. */
  export interface ObserveOptions {
    /**
     * The resource `service.name` of this node's records. `'service'` (default): every dispatch
     * span names its ozaco service (`todos`) and its descendants inherit it; records outside any
     * dispatch use the node's name (`OTEL_SERVICE_NAME`, else `name`). `'node'`: the node's name
     * for everything. Any other string: that name for everything.
     */
    readonly serviceName?: 'service' | 'node' | (string & Record<never, never>) | undefined

    /** `service.namespace`. Default: the application `name`. */
    readonly namespace?: string | undefined

    /** `deployment.environment.name`. Default: none. */
    readonly environment?: string | undefined
    readonly capture?: CaptureOptions | undefined

    /**
     * Claim the PROCESS's log records while this node observes: every record emitted where no
     * Trace sink records — tracing off there, not suppressed: a std Logger line of infrastructure
     * (transport, db) installed BEFORE `createServer`, in a parent scope, an `emitLog` /
     * `event()` / `recordFailure` there — reaches this node's store and exporters with its
     * resource (`service.name` = the node's, unless the record names a span service) and the
     * record's own scope (the `logger` binding). One node per process takes them (std:trace's
     * process fallback): the first observing node created; the next one takes over when it
     * stops. Logger lines need a `TraceTransport` visible where they are logged — install
     * `DefaultLogger` + `ConsoleTransport` + `TraceTransport` at the ROOT (the node then skips
     * its own install). Default `true`; ignored while the node does not observe.
     */
    readonly processLogs?: boolean | undefined
  }

  /** What telemetry may carry beyond the defaults (all off by default; secrets always
   * redacted). */
  export interface CaptureOptions {
    /** `http.request.header.<name>` / `http.response.header.<name>`. */
    readonly headers?: boolean | undefined

    /** request/response bodies (`http.*.body.content`, ≤ 2 KiB). */
    readonly bodies?: boolean | undefined

    /** websocket frame bodies (`ozaco.ws.message.body`, ≤ 2 KiB). */
    readonly frames?: boolean | undefined

    /** the verified principal as `enduser.id`. */
    readonly enduser?: boolean | undefined

    /** the names whose values are `REDACTED` in captured headers, bodies, frames and `url.query`
     * (replaces std:fetch's `SENSITIVE_KEYS`; `[...SENSITIVE_KEYS, 'my_key']` adds to it). */
    readonly sensitiveKeys?: readonly string[] | undefined
  }

  /** `createServer({ errors })`. */
  export interface ErrorOptions {
    /** `'chain'`: every failed edge reply carries the nested cause chain (`cause`) and the
     * `remote: …` causes a carrier hop added. Default: only callers `trace.trust` accepts get them
     * (a self-asserted `ozaco=1` never does). */
    readonly expose?: 'chain' | undefined
  }

  // --- resolved settings (kernel context) ------------------------------------------------------

  export interface TraceSettings {
    readonly inbound: 'link' | 'continue' | 'ignore'
    readonly trust: ((request: Request) => boolean) | null
    readonly response: boolean
  }

  /** The resolved capture flags — mutable: `ObservePlugin.use({ capture })` may turn flags on
   * while it installs. */
  export interface Capture {
    headers: boolean
    bodies: boolean
    frames: boolean
    enduser: boolean
    sensitiveKeys: readonly string[]
  }

  export interface ObserveSettings {
    /** `serviceName: 'service'` — dispatch spans set `service` = their ozaco service. */
    readonly perService: boolean

    /** the node-level `service.name`: the option's fixed name, else `OTEL_SERVICE_NAME`, else
     * the application `name`. */
    readonly serviceName: string
    readonly namespace: string
    readonly environment: string | null
    readonly capture: Capture
  }

  /** One `http.server.active_requests` series: the requests in flight with that method and
   * scheme. */
  export interface ActiveRequests {
    readonly method: string
    readonly scheme: string
    count: number
  }

  export interface Telemetry {
    readonly trace: TraceSettings
    readonly observe: ObserveSettings

    /** Node-level resource attributes (`service.namespace`, `service.version`,
     * `deployment.environment.name`, `telemetry.sdk.{name,version,language}`,
     * `ozaco.carrier.name`) — merged under every record's `service.name` / `service.instance.id`
     * (`resourceOf`). `createServer` completes it (the carrier) before tracing is enabled. */
    readonly resource: Record<string, TraceDef.AttrValue>
  }

  export interface ErrorSettings {
    readonly expose: 'chain' | null
  }

  /** Where a request entered: an edge / carrier (`external`) or `server.call` from outside any
   * dispatch (`internal`). */
  export type Origin = 'external' | 'internal'

  /** The request the running operation belongs to — the value of `RequestRef` (a frozen class
   * instance, shared by every fork). */
  export interface ActiveRequest {
    readonly requestId: string
    readonly origin: Origin
  }

  /** The ids a handler sees as `ctx.trace` — `''` span ids when tracing is off and no inbound
   * context arrived. */
  export interface Trace {
    readonly traceId: string
    readonly spanId: string
    readonly requestId: string
  }

  /** The kernel `Trace` impl's (`server-tracer`) context. */
  export interface TracerContext {
    readonly kernel: Context

    /** this node's tracing switch — `createServer` flips `enabled` once the plugins are in. */
    readonly state: TraceDef.TracingState

    /** the node's scope — where a span that outlives its dispatch (a streamed output's) ends. */
    readonly scope: Scope

    /** the log records emitted while the node was still coming up (its tracing off): its own,
     * and — when it was the process's first claimant — the process's, held until `createServer`
     * decides (handed to its Tracers when it observes, dropped otherwise); `null` once decided. */
    boot: BootRecord[] | null
  }

  /** One log record held while a node comes up (see {@link TracerContext.boot}). */
  export interface BootRecord {
    readonly log: TraceDef.LogData

    /** logged inside the node (else: outside every node — the process's). */
    readonly own: boolean
  }

  // --- handler context ----------------------------------------------------------------------

  export interface CallOptions {
    readonly timeoutMs?: number | undefined
    readonly idempotencyKey?: string | undefined

    /** extra wire metadata (strings) for the owner side. */
    readonly meta?: Readonly<Record<string, string>> | undefined

    /** carry the CALLER's `authorization` header into this nested call (`ctx.call` only —
     * intent stays visible at the call site, nothing travels silently; an explicit
     * `meta.authorization` still wins). */
    readonly inherit?: boolean | undefined
  }

  /** What follows `(service, action, …)` in a call: the input — omissible when the action
   * takes none — and the per-call options. */
  export type CallArgs<A> =
    ServiceDef.InputOf<A> extends undefined
      ? [input?: undefined, options?: CallOptions]
      : [input: ServiceDef.InputOf<A>, options?: CallOptions]

  /** The structured logger a handler writes with — every line is ONE log record correlated to
   * the span ACTIVE at the call (`@ozaco/server` scope; debug included), and is forwarded to the
   * installed std Logger (if any). */

  export interface Log {
    debug(msg: string, data?: Record<string, unknown>): Operation<void>
    info(msg: string, data?: Record<string, unknown>): Operation<void>
    warn(msg: string, data?: Record<string, unknown>): Operation<void>
    error(msg: string, data?: Record<string, unknown>): Operation<void>
  }

  /**
   * The one argument every handler, hook and plugin sees: WHO called, under WHICH ids, and the
   * seams that leave this action (`call`, `emit`, `span`, `log`). Resources are NOT mirrored
   * here — reach the database with `useDb(...tables)` (typed by your tables) and the cache with
   * `Kv.actions`, both from `@ozaco/db`.
   */
  export interface Ctx<TAuth = OptionsDef.Principal | null> {
    readonly requestId: string

    /** the dispatch span's id (`''` when nothing is traced) — `ctx.trace.spanId`. */
    readonly spanId: string
    readonly trace: Trace

    /** the service the action belongs to — for a socket, the service that declared it (`$edge`
     * for a route of the edge's own, `Edge.actions.socket`). */
    readonly service: string
    readonly action: string
    readonly meta: ServiceDef.Meta

    /** the verified caller, once an `Auth` plugin ran — `null` on an open action. */
    readonly auth: TAuth
    readonly log: Log

    /** aborted when the caller goes away (`onDisconnect: 'cancel'`) or the deadline passes. */
    readonly signal: AbortSignal

    /** edge headers / socket handshake / carrier meta (strings). */
    readonly headers: Readonly<Record<string, string>>

    /** Dispatch another action — local when the service is hosted here, over the carrier
     * otherwise. Plugins, validation and tracing apply. Typed end to end from the service
     * DEFINITION: `ctx.call(reports, 'summary', input)` — the action key, the input and the
     * resolved output all come from it. */

    call<S extends ServiceDef.Service, K extends ServiceDef.CallableKey<S>>(
      service: S,
      action: K,
      ...args: CallArgs<S['actions'][K]>
    ): Operation<ServiceDef.OutputOf<S['actions'][K]>>

    /** …or by REF (`server.api.todos.list`, `refs<typeof todos>('todos').list`) — the same
     * typing with no runtime import of the callee. */
    call<R extends ServiceDef.Ref>(
      target: R,
      ...args: CallArgs<ServiceDef.ActionOf<R>>
    ): Operation<ServiceDef.OutputOf<ServiceDef.ActionOf<R>>>

    /** Broadcast an event to every node (at-most-once). */
    emit(name: string, payload: unknown): Operation<void>

    /** Shape THIS call's successful edge response: a status and/or extra headers, merged over
     * the action's static `status`/`headers` (a later call wins per key). A call a gateway's
     * edge forwarded over a carrier carries it back to that edge (the reply's `http`). A no-op
     * when no edge answers the call (`ctx.call`, `server.call`, a carrier hop nobody's edge
     * made) — the reply then has no HTTP surface to shape. */
    reply(reply: Reply): void

    /** Open a child span under the ACTIVE one (custom instrumentation; kind `internal` unless
     * given). A Result the body returns is unwrapped (a failure raised): `attempt` the call to get
     * it back as a value. */
    span<T>(
      name: string,
      body: (span: TraceDef.SpanHandle) => Operation<T>,
      options?: SpanOptions,
    ): Operation<T>

    /** Record a named event: a span event on the ACTIVE recording span + one log record
     * (`eventName`, `otel.event.name`). `time` places it (epoch ms) — a timeline replayed after
     * the fact. */
    event(
      name: string,
      attributes?: TraceDef.AttributesInput,
      options?: EventOptions,
    ): Operation<void>
  }

  /** `ctx.span(name, body, options)` / `Server.actions.span`. */
  export interface SpanOptions {
    readonly kind?: TraceDef.SpanKind | undefined
    readonly attributes?: TraceDef.AttributesInput | undefined
    readonly links?: readonly TraceDef.LinkInput[] | undefined

    /** the instrumentation scope (a name, or `{ name, version }`). Default: the running
     * dispatch's ozaco service (`{ name: 'todos', version }`), else the node's name. */
    readonly scope?: string | TraceDef.InstrumentationScope | undefined
  }

  /** `Server.actions.span(name, body, options)` — may also start a trace of its own. */
  export interface RootSpanOptions extends SpanOptions {
    /** an explicit parent; `null` starts a new trace. Default: the active span. */
    readonly parent?: TraceDef.SpanContext | null | undefined

    /** local roots only: `'errors'` exports the trace only when something in it failed. */
    readonly record?: 'always' | 'errors' | undefined
  }

  /** `ctx.event(name, attributes, options)`. */
  export interface EventOptions {
    /** epoch ms; default now (on the active span's clock). */
    readonly time?: number | undefined
  }

  // --- dispatch ------------------------------------------------------------------------------

  /** What a handler may say about its successful HTTP reply — see {@link Ctx.reply}. */
  export interface Reply {
    readonly status?: number | undefined
    readonly headers?: Readonly<Record<string, string>> | undefined
  }

  /** One dispatch as the kernel sees it (before plugins). */
  export interface Call {
    /** carrier correlation (lanes, outcomes, cancel) — ALWAYS `newSpanId()`, never a span id. */
    readonly cid: string
    readonly service: string
    readonly action: string
    readonly input: unknown

    /** the request this dispatch belongs to (valid inbound `x-request-id` / the wire's
     * `request_id`, else minted where the request entered). */
    readonly requestId: string
    readonly origin: Origin

    /**
     * The dispatch span's parent when it is NOT the active span: the context a carrier
     * extracted from the wire (`remote: true` ⇒ a SERVER span), or `null` to start a new trace.
     * Omitted: the active span (edge span, the caller's span in-process).
     */
    readonly parent?: TraceDef.SpanContext | null | undefined
    readonly headers: Readonly<Record<string, string>>
    readonly deadline: number
    readonly idempotencyKey: string | undefined

    /** `edge`, `local`, or the carrier's transport name (`memory`, `nats`, …). */
    readonly transport: string
    readonly signal: AbortSignal

    /** abort `signal` (the kernel fires it right before a cancelled handler is torn down, so the
     * handler's own cleanup sees `signal.aborted`). */
    readonly abort?: ((reason: string) => void) | undefined

    /** The edge's sink for {@link Ctx.reply} — also on a carrier hop (it carries the reply
     * back to the edge that forwarded the call); absent on `ctx.call` / `server.call`. */
    readonly reply?: ((reply: Reply) => void) | undefined
  }

  export type Dispatch = (call: Call, ctx: Ctx) => Operation<unknown>

  // --- plugin contract -------------------------------------------------------------------------

  /** What a server plugin's `setup()` may return — the kernel reads it right after installing the
   * plugin. Everything is optional; a plugin that only wants the install (an `Edge`, a `Kv`
   * store) returns nothing. */

  export interface PluginContext {
    readonly hooks?: Hooks | undefined

    /** action-option keys this plugin owns, with their validators. */
    readonly options?: Readonly<Record<string, StandardSchemaV1>> | undefined

    /** services this plugin brings (the observe console's API, …): `createServer` registers
     * them like the app's own — routed, mounted, documented — and hosts them locally. */
    readonly services?: readonly ServiceDef.Service[] | undefined
  }

  export interface Hooks {
    readonly name: string

    /** wraps every dispatch (innermost = handler). */
    readonly dispatch?: ((call: Call, ctx: Ctx, next: Dispatch) => Operation<unknown>) | undefined

    /** observes every finished span and log record (the observe store). */
    readonly observe?: ((event: ObserveDef.Event) => Operation<void>) | undefined

    /** gates every raw edge route (the Auth plugin): resolves the verified principal the
     * handler receives; a failure is the response (401/403). */
    readonly guard?:
      | ((route: EdgeDef.RawRoute, request: Request) => Operation<OptionsDef.Principal | null>)
      | undefined

    /** runs once the server listens / before it stops. */
    readonly start?: (() => Operation<void>) | undefined
    readonly stop?: (() => Operation<void>) | undefined

    /** runs after `reload(services)` swapped the registry — a plugin that derived state from
     * the declarations at `start` (watchers, caches) refreshes it here. */
    readonly reload?: ((report: ReloadReport) => Operation<void>) | undefined
  }

  /** What one `reload(services)` changed, by service name. */
  export interface ReloadReport {
    /** services that were not declared before. */
    readonly added: readonly string[]

    /** services the new declaration no longer has (their routes are gone). */
    readonly removed: readonly string[]

    /** services declared before AND now — their actions were swapped for the new definitions. */
    readonly replaced: readonly string[]

    /** how many action routes / socket routes the node serves now. */
    readonly actions: number
    readonly sockets: number
  }

  // --- kernel context/actions ---------------------------------------------------------------

  export interface Registry {
    readonly services: ReadonlyMap<string, ServiceDef.Service>
    readonly actions: ReadonlyMap<string, ServiceDef.Action>

    /** sockets declared inside services (`action.socket`) — the edge mounts them at `mount()`. */
    readonly sockets: readonly ServiceDef.ServiceSocket[]
  }

  export interface Context {
    readonly name: string
    readonly version: string
    readonly instance: string
    readonly serviceId: string
    readonly registry: Registry
    readonly hooks: Hooks[]
    readonly options: Map<string, StandardSchemaV1>
    readonly events: EventEmitter<Events>
    readonly timeoutMs: number

    /** the pinned carrier/edge/outcomes handles — set by `createServer` as it installs them. */
    carrier: CarrierDef | null
    edge: EdgeDef | null
    outcomes: OutcomesDef | null

    /** what this node is — every declared service still resolves, hosted ones locally. */
    readonly role: Role

    /** the services this node serves (every declared one, unless the role narrows it). */
    readonly hosted: Set<string>

    /** services a PLUGIN registered (`PluginContext.services`): always hosted here, and never
     * touched by `reload` — that swaps the application's declarations only. */
    readonly pluginServices: Set<string>

    /** plugin services whose own dispatches are recorded IN FULL — every other plugin service
     * records only when it fails (`record: 'errors'`). `ObservePlugin.use({ selfTrace: true })`
     * adds `observe`. */
    readonly selfTraced: Set<string>

    /** dispatches running here right now (what `stop()` drains). */
    inflight: number

    /** HTTP requests the edge is answering right now (open edge spans — a streamed body keeps
     * its request active), per `http.request.method` + `url.scheme`: what exporters report as
     * `http.server.active_requests`. */
    readonly active: Map<string, ActiveRequests>

    /** whether any `ObserveExporter` is installed — set by `createServer` once the plugins are
     * in, read on the hot path (events are fanned out to exporters only when one listens). */
    exporting: boolean

    /** whether this node records telemetry (an exporter, an observe hook, or a Trace sink already
     * enabled around `createServer`) — set by `createServer` once the plugins are in; the
     * `server-tracer` switch follows it. */
    observing: boolean

    /** the resolved `trace` / `observe` options and the node-level resource. */
    readonly telemetry: Telemetry

    /** the resolved `errors` option. */
    readonly errors: ErrorSettings

    /** socket routes mounted on the edge (for docs / the manifest). */
    readonly sockets: EdgeDef.SocketInfo[]

    /** raw routes mounted on the edge outside the action model (health, docs, the observe
     * console) — what the manifest reports as actually being there. */
    readonly routes: { readonly method: string; readonly path: string }[]
  }

  export type Events = {
    observe: [event: ObserveDef.Event]
    event: [envelope: WireDef.Event]
  }

  /** One event as `Server.actions.events()` yields it (own emits included). No span is opened
   * per item — `Server.actions.process(item, body)` opens the consumer span. */
  export interface EventItem {
    /** the envelope's message id (`messaging.message.id`), minted per emit — absent from a
     * pre-id node's envelope. */
    readonly id?: string | undefined
    readonly name: string
    readonly payload: unknown

    /** the emitting node's service id. */
    readonly origin: string

    /** the emitter's PRODUCER span — what a consumer span LINKS to (`creation`); `null` when
     * the envelope carried none. */
    readonly trace: TraceDef.SpanContext | null

    /** the emitter's request id (`''` when the envelope carried none). */
    readonly requestId: string
  }

  export interface Actions {
    /** Dispatch one action here (the carrier's inbound path and the edge's path). The result
     * travels as a Result; the plugin runtime unwraps it, so callers `attempt()` it. */
    dispatch(call: Call): Operation<unknown>

    /** Dispatch by service definition from outside a handler (tests, scripts): local or over
     * the carrier — same typed shape as `ctx.call`. */
    call<S extends ServiceDef.Service, K extends ServiceDef.CallableKey<S>>(
      service: S,
      action: K,
      ...args: CallArgs<S['actions'][K]>
    ): Operation<ServiceDef.OutputOf<S['actions'][K]>>

    call<R extends ServiceDef.Ref>(
      target: R,
      ...args: CallArgs<ServiceDef.ActionOf<R>>
    ): Operation<ServiceDef.OutputOf<ServiceDef.ActionOf<R>>>
    emit(name: string, payload: unknown): Operation<void>

    /** Events arriving from every node (own emits included; `_`-prefixed internal events
     * hidden). An ambient recording span gets an `event.recv` span event per item
     * (`messaging.message.id`) and, for its first 32 items, a LINK to the item's creation context
     * (`ozaco.link.reason = 'creation'`). The flow ends when the carrier's subscription does (the
     * node stopping). */
    events(name?: string): Flow<EventItem, never>

    /** Handle one item of {@link events} in a CONSUMER span `process {event}` that links the
     * emitter's span (`creation`). */
    process<T>(item: EventItem, body: (span: TraceDef.SpanHandle) => Operation<T>): Operation<T>

    /** The resolved manifest: services, actions, routes, planes, errors. */
    manifest(): Operation<Manifest>

    /**
     * Swap the APPLICATION's service declarations for `services` on the running node — the
     * edge keeps listening, sockets stay open, the carrier keeps its membership. New routes are
     * mounted, gone ones unmounted, in-flight dispatches finish on the definitions they
     * started with. Plugin-registered services are kept. The swap is atomic: an invalid
     * declaration (a duplicate name, an option no plugin handles) fails `server.configuration`
     * and leaves everything as it was. This is what `HotReload` (plugins) drives from the file
     * watcher — and what a test or a control endpoint calls directly.
     */
    reload(services: readonly ServiceDef.Service[]): Operation<ReloadReport>

    /** Report a DOMAIN record (audit trail, business event) from application code: one log
     * record (`eventName: 'ozaco.local'`, `ozaco.local.stream`, the fields flattened) every
     * sink receives, correlated to the active span. Spans and logs are the kernel's own. */
    report(record: ObserveDef.DomainRecord): Operation<void>

    /** Run `body` in a span — under the active one, or a trace of its own (background work). */
    span<T>(
      name: string,
      body: (span: TraceDef.SpanHandle) => Operation<T>,
      options?: RootSpanOptions,
    ): Operation<T>
  }

  export interface ManifestAction {
    readonly service: string
    readonly action: string
    readonly kind: ServiceDef.Kind
    readonly route: ServiceDef.Route
    readonly inputPlane: ServiceDef.Meta['inputPlane']
    readonly outputPlane: ServiceDef.Meta['outputPlane']
    readonly inputBrand: string | null
    readonly outputBrand: string | null
    readonly errors: Readonly<Record<string, number>>
    readonly tags: readonly string[]
    readonly title: string | undefined
    readonly description: string | undefined
  }

  export interface Manifest {
    readonly name: string
    readonly version: string
    readonly instance: string
    readonly actions: readonly ManifestAction[]
  }

  /** The handle `createServer` resolves. */
  export interface Handle<TServices extends readonly ServiceDef.Service[] = ServiceDef.Service[]> {
    readonly api: ServiceDef.Api<TServices>
    readonly name: string
    readonly serviceId: string
    readonly role: Role

    /** Run every plugin's `start` hook, mount the health route, listen (when an edge is
     * installed), then wait for `dependsOn`. `listen` overrides `options.listen`. */
    start(listen?: ListenOptions): Operation<Info>

    /** Pause the edge, leave the cluster, drain in-flight work, unserve, run `stop` hooks. */
    stop(): Operation<void>
    info(): Operation<Info>
    health(): Operation<Health>

    /** Who serves a service, by the carrier's presence (this node included when it hosts it). */
    members(service: string): Operation<readonly CarrierDef.Member[]>
    call: Actions['call']
    emit: Actions['emit']
    events: Actions['events']
    manifest: Actions['manifest']

    /** Swap the service declarations in place — see `Actions.reload`. */
    reload: Actions['reload']
  }

  export interface Info {
    readonly role: Role
    readonly hosted: readonly string[]
    readonly url: string | null
    readonly port: number | null
    readonly started: boolean

    /** every `dependsOn` service has a live member. */
    readonly ready: boolean
  }

  /** What `/_health` answers. */
  export interface Health {
    readonly ok: boolean
    readonly ready: boolean
    readonly role: Role
    readonly hosted: readonly string[]
    readonly serviceId: string
    readonly members: Readonly<Record<string, readonly CarrierDef.Member[]>>
  }

  export interface ListenOptions {
    readonly port?: number | undefined
    readonly hostname?: string | undefined
  }

  export interface ListenInfo {
    readonly url: string | null
    readonly port: number | null
  }

  export type Client = Plugin<Context, [options: Options], Actions>
}
