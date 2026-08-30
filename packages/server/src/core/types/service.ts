// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { ACTION, SERVICE } from '../const'

import type { EdgeDef } from './edge'
import type { OptionsDef } from './options'
import type { ServerDef } from './server'
import type { StreamDef } from './stream'

/**
 * The user-facing definition model: `service(name, { action: action.query({...}, handler) })`.
 * Everything the kernel, the edge, the carriers, the plugins and the docs read about an action
 * is resolved ONCE here into plain data (`ActionDef.meta`) — no runtime sniffing.
 */
export namespace ServiceDef {
  export type Schema = StandardSchemaV1

  /** The function taxonomy (Convex-flavored): drives the default HTTP method, the manifest and
   * the client behaviour. */
  export type Kind = 'query' | 'mutation' | 'action' | 'stream'

  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

  export interface Route {
    readonly method: HttpMethod
    readonly path: string
  }

  /** What `input` / `output` accept: a bare schema (the value plane), a branded stream, a
   * multipart declaration, or nothing. */
  export type Declaration = Schema | StreamDef.Decl | StreamDef.PartsDecl

  /** What happens to a running handler when the caller disconnects or abandons the call. */
  export type DisconnectMode = 'cancel' | 'detach'

  /**
   * An action's configuration: what it takes, what it answers, where it lives — plus the plugin
   * options ({@link OptionsDef.ActionOptions}: `auth`, `cache`, `timeoutMs`, `retry`, …), typed
   * fields rather than an open bag. An unknown key is a compile error here and a configuration
   * failure at `createServer`: an option nobody handles is a typo, not a feature.
   */
  export interface Config<
    TInput extends Declaration | undefined = Declaration | undefined,
    TOutput extends Declaration | undefined = Declaration | undefined,
  >
    extends OptionsDef.ActionOptions {
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly input?: TInput
    readonly output?: TOutput
    readonly route?: Route | undefined
    readonly onDisconnect?: DisconnectMode | undefined

    /** Always persist this action's outcome (otherwise only undeliverable replies are). */
    readonly outcome?: boolean | undefined

    /** Failure tag → HTTP status overrides; also feeds the docs error catalog. */
    readonly errors?: Readonly<Record<string, number>> | undefined
    readonly tags?: readonly string[] | undefined

    /** Free-form documentation the manifest publishes VERBATIM on this action's entry (a
     * resource's filter surface, examples, vendor extensions…) — JSON-safe values only. */
    readonly docs?: Readonly<Record<string, unknown>> | undefined
  }

  /** The handler's `params` type: the value plane of the input. */
  export type Params<D> = D extends undefined
    ? undefined
    : D extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<D>
      : D extends StreamDef.Decl<infer B, infer T>
        ? StreamDef.Branded<B, T>
        : D extends StreamDef.PartsDecl<infer TFields, infer TStreams>
          ? StreamDef.Parts<TFields, TStreams>
          : unknown

  /** A declared array output also accepts a READONLY one — `db.query(...).collect()` and every
   * other read answers `readonly Row[]`, and the kernel only validates and serializes it. */
  export type Loose<T> = T extends readonly (infer Element)[] ? readonly Element[] | T : T

  /** The handler's return type: the value plane of the output, or — for a stream output — any
   * of the four shapes the kernel normalizes: an already-branded stream, a Flow (`flowOf`), an
   * array, or an async iterable. */
  export type Returns<D> = D extends undefined
    ? void
    : D extends StandardSchemaV1
      ? Loose<StandardSchemaV1.InferOutput<D>>
      : D extends StreamDef.Decl<infer B, infer T>
        ? StreamDef.Branded<B, T> | StreamDef.Source<T> | readonly T[] | AsyncIterable<T>
        : unknown

  /** Everything resolved about an action: what the kernel/edge/carriers/plugins/docs read. */
  export interface Meta {
    readonly kind: Kind
    readonly title: string | undefined
    readonly description: string | undefined
    readonly input: Declaration | null
    readonly output: Declaration | null

    /** value | stream | parts — derived from the declarations. */
    readonly inputPlane: 'none' | 'value' | 'stream' | 'parts'
    readonly outputPlane: 'none' | 'value' | 'stream'
    readonly route: Route
    readonly onDisconnect: DisconnectMode
    readonly outcome: boolean
    readonly errors: Readonly<Record<string, number>>
    readonly tags: readonly string[]

    /** free-form docs block, published verbatim in the manifest (`null` when none). */
    readonly docs: Readonly<Record<string, unknown>> | null

    /** plugin options as given (validated at createServer). */
    readonly options: Readonly<Record<string, unknown>>
  }

  /** The handler signature: ONE argument. */
  export type Handler<TParams, TResult, TCtx> = (call: {
    readonly input: TParams
    readonly ctx: TCtx
  }) => Operation<TResult>

  /** What `ctx.auth` is INSIDE a handler, decided by its `auth:` option: any truthy
   * requirement guarantees a verified principal before the handler runs, so the null check
   * disappears from the body; no `auth` (or `auth: false`) keeps the nullable form. */
  export type AuthOf<R> = R extends undefined | false
    ? OptionsDef.Principal | null
    : OptionsDef.Principal

  export interface Action<
    TInput extends Declaration | undefined = Declaration | undefined,
    TOutput extends Declaration | undefined = Declaration | undefined,
    TAuth extends OptionsDef.Principal | null = OptionsDef.Principal | null,
  > {
    readonly _t: typeof ACTION
    readonly meta: Meta
    readonly handler: Handler<Params<TInput>, Returns<TOutput>, ServerDef.Ctx<TAuth>>
    readonly [INPUT]?: TInput
    readonly [OUTPUT]?: TOutput
  }

  /** A socket declared INSIDE a service (`action.socket`): mounted as a WS route at the edge,
   * listed under the service in the manifest — not callable, not carried. */
  export interface SocketConfig<
    TReceives extends Schema | undefined = undefined,
    TSends extends Schema | undefined = undefined,
  > {
    /** what a CLIENT may send. Every inbound frame is validated against it: a malformed one is
     * dropped and reported (one bad frame never kills the session), so `socket.messages` is
     * typed by it. */
    readonly receives?: TReceives

    /** what the SERVER sends — it types `socket.send` and is published in the manifest. Outbound
     * frames are not re-validated on the wire. */
    readonly sends?: TSends

    /** the WS path. Default `/<service>/<action>`. */
    readonly path?: string | undefined

    /** what travels on it, for docs (`resource`, `chat`, …). */
    readonly protocol?: string | undefined
    readonly description?: string | undefined

    /** the socket's auth seam. With an `authorization` header (non-browser clients) it runs
     * BEFORE the upgrade — a failure rejects the handshake with its status. Without one the
     * upgrade is accepted and the seam runs on the FIRST frame (`{ t: 'auth', token }` within
     * a short grace, or no token at all): a failure then closes the socket. What it resolves
     * becomes the socket ctx's `auth`. Tokens never travel in the URL. */
    readonly authorize?: ((request: Request, token?: string) => Operation<unknown>) | undefined

    /** WHEN `authorize` runs. `'upgrade'` (default): before the upgrade — a failure rejects the
     * handshake. `'first-frame'`: without an authorization header the upgrade is accepted and
     * the seam runs on the first frame (`{ t: 'auth', token }` within a short grace, or
     * token-less) — for browser-facing sockets, where tokens cannot ride a header and must
     * never ride the URL. */
    readonly authorizeMode?: 'upgrade' | 'first-frame' | undefined

    /** opening-frame defaults documented in the manifest (e.g. `{ cursor: 0 }` on realtime). */
    readonly defaults?: Readonly<Record<string, unknown>> | undefined
  }

  export interface SocketSpec {
    readonly path: string
    readonly protocol: string | null
    readonly description: string | null
    readonly authorize: ((request: Request, token?: string) => Operation<unknown>) | null
    readonly authorizeMode: 'upgrade' | 'first-frame'
    readonly defaults: Readonly<Record<string, unknown>> | null
    readonly receives: Schema | null
    readonly sends: Schema | null
  }

  /** What a socket handler receives / may send, from its declarations. */
  export type Frames<D extends Schema | undefined> = D extends Schema
    ? StandardSchemaV1.InferOutput<D>
    : unknown

  /** A socket entry, its frame declarations carried in the TYPE — `typeof svc` keeps them, so
   * the manifest and a generated client can speak this socket's frames. */
  export interface SocketAction<
    TReceives extends Schema | undefined = Schema | undefined,
    TSends extends Schema | undefined = Schema | undefined,
  > {
    readonly _t: typeof ACTION
    readonly socket: SocketSpec
    readonly handler: (socket: EdgeDef.Socket<Frames<TReceives>, Frames<TSends>>) => Operation<void>
    readonly [RECEIVES]?: TReceives
    readonly [SENDS]?: TSends
  }

  /** The inbound frame type of a socket entry. */
  export type ReceivesOf<A> = A extends SocketAction<infer R, AnyType> ? Frames<R> : never

  /** The outbound frame type of a socket entry. */
  export type SendsOf<A> = A extends SocketAction<AnyType, infer T> ? Frames<T> : never

  /** A registered socket, service attached — what the registry hands the edge. */
  export interface ServiceSocket extends SocketSpec {
    readonly service: string
    readonly handler: (socket: AnyType) => Operation<void>
  }

  export type ActionEntry = Action<AnyType, AnyType, AnyType> | SocketAction<AnyType, AnyType>

  export type ActionMap = Record<string, ActionEntry>

  export interface Service<TName extends string = string, TActions extends ActionMap = ActionMap> {
    readonly _t: typeof SERVICE
    readonly name: TName
    readonly version: string
    readonly description: string | undefined
    readonly actions: TActions
  }

  export interface ServiceOptions {
    readonly version?: string | undefined
    readonly description?: string | undefined
  }

  // --- typed references (what `ctx.call` / the client take) ----------------------------------

  export type ActionKey<S extends Service> = keyof S['actions'] & string

  /** The CALLABLE action keys of a service (sockets are not callable) — what `ctx.call` takes
   * next to the service definition. */
  export type CallableKey<S extends Service> = {
    [K in keyof S['actions']]: S['actions'][K] extends SocketAction<AnyType, AnyType> ? never : K
  }[keyof S['actions']] &
    string

  export type InputOf<A> = A extends Action<infer I, AnyType, AnyType> ? Params<I> : never
  export type OutputOf<A> = A extends Action<AnyType, infer O, AnyType> ? Returns<O> : never

  /** A typed pointer to one action of one service (what the CLIENT api map carries, and what
   * `ctx.call` accepts next to a service definition). */
  export interface Ref<A extends Action = Action> {
    readonly service: string
    readonly action: string
    readonly [ACTION_REF]?: A
  }

  /** Every callable action of a service, as refs — what `refs<typeof todos>('todos')` builds
   * from a TYPE-ONLY import, so calling a service never creates a runtime import edge. */
  export type Refs<S extends Service> = {
    readonly [K in CallableKey<S>]: Ref<Extract<S['actions'][K], Action<AnyType, AnyType, AnyType>>>
  }

  /** The action a ref points at. */
  export type ActionOf<R> = R extends Ref<infer A> ? A : never

  export type Api<TServices extends readonly Service[]> = {
    readonly [S in TServices[number] as S['name']]: {
      readonly [
        K in keyof S['actions'] as S['actions'][K] extends SocketAction<AnyType, AnyType>
          ? never
          : K
      ]: Ref<Extract<S['actions'][K], Action<AnyType, AnyType, AnyType>>>
    }
  }
}

declare const INPUT: unique symbol
declare const OUTPUT: unique symbol
declare const ACTION_REF: unique symbol
declare const RECEIVES: unique symbol
declare const SENDS: unique symbol
