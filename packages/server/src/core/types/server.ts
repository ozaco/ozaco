import type { Database, KvDef, Schema, Spec } from 'db:core'
import type { Flow, Operation } from 'std:effect'
import type { EventEmitter } from 'std:event'
import type { Plugin } from 'std:plugin'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { CarrierDef } from './carrier'
import type { EdgeDef } from './edge'
import type { ObserveDef } from './observe'
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

    /** Which of the declared services THIS node hosts (the rest are reached over the carrier).
     * Default: all of them. A gateway node declares everything and hosts `[]`. */
    readonly hosted?: readonly string[] | undefined

    /** How long `stop()` waits for in-flight dispatches after leaving the cluster. Default:
     * `timeoutMs`. */
    readonly drainMs?: number | undefined
  }

  // --- handler context ----------------------------------------------------------------------

  export interface CallOptions {
    readonly timeoutMs?: number | undefined
    readonly idempotencyKey?: string | undefined

    /** extra wire metadata (strings) for the owner side. */
    readonly meta?: Readonly<Record<string, string>> | undefined
  }

  /** The structured logger a handler writes with — every line lands in the observe store
   * bound to the current request/span. */

  export interface Log {
    debug(msg: string, data?: Record<string, unknown>): Operation<void>
    info(msg: string, data?: Record<string, unknown>): Operation<void>
    warn(msg: string, data?: Record<string, unknown>): Operation<void>
    error(msg: string, data?: Record<string, unknown>): Operation<void>
  }

  /** The one argument every handler, hook and plugin sees. */
  export interface Ctx<TAuth = unknown> {
    readonly requestId: string
    readonly spanId: string
    readonly trace: TraceDef.Trace
    readonly service: string
    readonly action: string
    readonly meta: ServiceDef.Meta

    /** the installed database handle, rows as plain documents (use `useDb(...tables)` for the
     * fully typed handle); fails `server.configuration` on use when none is installed. */
    readonly db: Database.Handle<Record<string, Schema.Types<Spec.Doc, Spec.Doc>>>

    /** the installed `Kv` store's actions (fails `server.configuration` when none is installed). */
    readonly cache: KvDef.Actions
    readonly auth: TAuth
    readonly log: Log

    /** aborted when the caller goes away (`onDisconnect: 'cancel'`) or the deadline passes. */
    readonly signal: AbortSignal

    /** edge headers / socket handshake / carrier meta (strings). */
    readonly headers: Readonly<Record<string, string>>

    /** Dispatch another action — local when the service is hosted here, over the carrier
     * otherwise. Plugins, validation and tracing apply. */

    call<A extends ServiceDef.Action>(
      ref: ServiceDef.Ref<A>,
      input: ServiceDef.InputOf<A>,
      options?: CallOptions,
    ): Operation<ServiceDef.OutputOf<A>>

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

    /** the services this node serves (every declared one, unless `app` roles narrow it). */
    readonly hosted: Set<string>

    /** whether a `Kv` store answered at createServer time (cloneable protocol contexts are only
     * readable during a dispatch, so the probe result is kept here). */
    kv: boolean

    /** dispatches running here right now (what `stop()` drains). */
    inflight: number

    /** socket routes mounted on the edge (for docs / the manifest). */
    readonly sockets: EdgeDef.SocketInfo[]
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

    /** Dispatch by reference from outside a handler (tests, scripts): local or over the carrier. */
    call<A extends ServiceDef.Action>(
      ref: ServiceDef.Ref<A>,
      input: ServiceDef.InputOf<A>,
      options?: CallOptions,
    ): Operation<ServiceDef.OutputOf<A>>
    emit(name: string, payload: unknown): Operation<void>

    /** Events arriving from every node (own emits included). */
    events(name?: string): Flow<WireDef.Event, never>

    /** The resolved manifest: services, actions, routes, planes, errors. */
    manifest(): Operation<Manifest>

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

    /** Start the edge (when one is installed) and every plugin's `start` hook. */
    listen(options?: ListenOptions): Operation<ListenInfo>

    /** Leave the cluster, stop accepting, drain in-flight work, unserve, run `stop` hooks. */
    stop(): Operation<void>

    /** Who serves a service, by the carrier's presence (this node included when it hosts it). */
    members(service: string): Operation<readonly CarrierDef.Member[]>
    call: Actions['call']
    emit: Actions['emit']
    events: Actions['events']
    manifest: Actions['manifest']
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
