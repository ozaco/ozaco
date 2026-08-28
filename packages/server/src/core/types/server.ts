import type { Flow, Operation } from 'std:effect'
import type { EventEmitter } from 'std:event'
import type { Plugin } from 'std:plugin'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { CarrierDef } from './carrier'
import type { EdgeDef } from './edge'
import type { ObserveDef } from './observe'
import type { OptionsDef } from './options'
import type { OutcomesDef } from './outcomes'
import type { ServiceDef } from './service'
import type { TraceDef } from './trace'
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

  /** The structured logger a handler writes with — every line lands in the observe store
   * bound to the current request/span. */

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
    readonly spanId: string
    readonly trace: TraceDef.Trace
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

    /** Open a child span under this one (custom instrumentation). */
    span<T>(name: string, body: () => Operation<T>, attrs?: Record<string, unknown>): Operation<T>
  }

  // --- dispatch ------------------------------------------------------------------------------

  /** One dispatch as the kernel sees it (before plugins). */
  export interface Call {
    readonly cid: string
    readonly service: string
    readonly action: string
    readonly input: unknown
    readonly trace: TraceDef.Trace
    readonly headers: Readonly<Record<string, string>>
    readonly deadline: number
    readonly idempotencyKey: string | undefined
    readonly transport: string
    readonly signal: AbortSignal

    /** abort `signal` (the kernel fires it right before a cancelled handler is torn down, so the
     * handler's own cleanup sees `signal.aborted`). */
    readonly abort?: ((reason: string) => void) | undefined
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
  }

  export interface Hooks {
    readonly name: string

    /** wraps every dispatch (innermost = handler). */
    readonly dispatch?: ((call: Call, ctx: Ctx, next: Dispatch) => Operation<unknown>) | undefined

    /** observes every finished span/log/failure/event (the observe plugin). */
    readonly observe?: ((event: ObserveDef.Event) => Operation<void>) | undefined

    /** runs once the server listens / before it stops. */
    readonly start?: (() => Operation<void>) | undefined
    readonly stop?: (() => Operation<void>) | undefined
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
    carrier: CarrierDef.Handle | null
    edge: EdgeDef.Handle | null
    outcomes: OutcomesDef.Handle | null

    /** what this node is — every declared service still resolves, hosted ones locally. */
    readonly role: Role

    /** the services this node serves (every declared one, unless the role narrows it). */
    readonly hosted: Set<string>

    /** dispatches running here right now (what `stop()` drains). */
    inflight: number

    /** socket routes mounted on the edge (for docs / the manifest). */
    readonly sockets: EdgeDef.SocketInfo[]

    /** raw routes mounted on the edge outside the action model (health, docs, the observe
     * console) — what the manifest reports as actually being there. */
    readonly routes: { readonly method: string; readonly path: string }[]
  }

  export type Events = {
    observe: [event: ObserveDef.Event]
    event: [name: string, payload: unknown, trace: TraceDef.Wire | undefined]
  }

  export interface Actions {
    describe(): Operation<Context>

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

    /** Events arriving from every node (own emits included). */
    events(name?: string): Flow<WireDef.Event, never>

    /** The resolved manifest: services, actions, routes, planes, errors. */
    manifest(): Operation<Manifest>

    /** Report an observe event from application code — the `domain` row is the one meant for
     * you: a free-form audit/business record every installed exporter ships (the observe store
     * skips it). Spans, logs and failures are reported by the kernel itself. */
    report(event: ObserveDef.Event): Operation<void>

    /** Open a span outside a dispatch (edge requests, background work). */
    span<T>(
      name: string,
      body: (trace: TraceDef.Trace) => Operation<T>,
      options?: SpanOptions,
    ): Operation<T>
  }

  export interface SpanOptions {
    readonly kind?: TraceDef.SpanKind | undefined
    readonly parent?: TraceDef.Trace | undefined
    readonly origin?: TraceDef.Origin | undefined
    readonly requestId?: string | undefined
    readonly attrs?: Record<string, unknown> | undefined
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
