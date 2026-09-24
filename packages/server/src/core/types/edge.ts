import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { OptionsDef } from './options'
import type { ServerDef } from './server'
import type { ServiceDef } from './service'

/** A built edge plugin (`BunEdge`, `NodeEdge`, …) — install options are the impl's own, so the
 * argument list stays open. */
export type EdgeDef = Plugin<EdgeDef.Context, AnyType[], EdgeDef.Actions>

/**
 * The edge protocol: the HTTP/WebSocket face of a server. The ENGINE (routing, body parsing,
 * branded stream bodies, SSE, sockets, request ids, decorators) lives in core over the web
 * `Request`/`Response` types; an impl is one thin driver: how to listen on this runtime.
 */
export namespace EdgeDef {
  export interface Options {
    readonly runtime: string
  }

  /** What the install resolves is exactly {@link Options} here. */
  export type Context = Options

  export interface ListenOptions {
    readonly port?: number | undefined
    readonly hostname?: string | undefined
  }

  export interface ListenInfo {
    readonly url: string
    readonly port: number
    readonly hostname: string
  }

  /** What a socket route handler receives. `ctx.auth` carries what the route's `authorize`
   * resolved on the handshake — a handler never verifies the token a second time. */
  export interface Socket<TIn = unknown, TOut = unknown> {
    readonly id: string
    readonly params: Readonly<Record<string, string>>
    readonly headers: Readonly<Record<string, string>>

    /** the upgrade request's url — query params included (`?token=`, filters, …). */
    readonly url: URL
    readonly ctx: ServerDef.Ctx

    /** inbound messages (codec values). With a `receives` schema on the action, every frame is
     * validated before it lands here — a malformed one is dropped and reported, never delivered. */
    readonly messages: Flow<TIn, void>
    send(value: TOut): Operation<void>
    close(code?: number, reason?: string): Operation<void>
  }

  export type SocketHandler<TIn = unknown, TOut = unknown> = (
    socket: Socket<TIn, TOut>,
  ) => Operation<void>

  /** A response decorator: runs on every response (errors included). */
  export type Decorator = (request: Request, response: Response) => Operation<Response>

  /** Answers unrouted OPTIONS requests (CORS preflight); `null` = not handled. */
  export type Preflight = (request: Request) => Operation<Response | null>

  export interface SocketRoute {
    readonly path: string
    readonly handler: SocketHandler

    /** validates every inbound frame when the action declared one. */
    readonly receives?: StandardSchemaV1 | undefined

    /** documented in the manifest; not re-validated on the wire. */
    readonly sends?: StandardSchemaV1 | undefined

    /** runs before the upgrade; a failure rejects the handshake with its status. What it
     * RESOLVES (the verified principal) becomes the socket ctx's `auth` — verified once, on
     * the handshake. */
    readonly authorize?: ((request: Request, token?: string) => Operation<unknown>) | undefined

    /** `'first-frame'` defers a header-less handshake to the first `{ t: 'auth' }` frame. */
    readonly authorizeMode?: 'upgrade' | 'first-frame' | undefined

    /** the service this socket belongs to (docs list it under the service). */
    readonly service?: string | undefined

    /** what travels on it, for docs (`resource` = watch/unwatch ↔ sync/delta frames). */
    readonly protocol?: string | undefined
    readonly description?: string | undefined

    /** opening-frame defaults documented in the manifest (e.g. `{ cursor: 0 }` on realtime). */
    readonly defaults?: Readonly<Record<string, unknown>> | undefined
  }

  /** A mounted socket route as the kernel lists it (docs, manifest). */
  export interface SocketInfo {
    readonly path: string
    readonly service: string | null
    readonly protocol: string | null
    readonly description: string | null

    /** how the socket authorizes (`'first-frame'` = in-band `{ t: 'auth' }`). */
    readonly authorizeMode?: 'upgrade' | 'first-frame' | undefined

    /** opening-frame defaults documented in the manifest (e.g. `{ cursor: 0 }` on realtime). */
    readonly defaults: Readonly<Record<string, unknown>> | null

    /** the declared frame schemas, for the manifest (`receives` also validates the wire). */
    readonly receives: StandardSchemaV1 | null
    readonly sends: StandardSchemaV1 | null
  }

  /** What a raw route handler receives besides the request and its params. */
  export interface RawContext {
    /** the caller the `Auth` gate verified (`null` when anonymous, or when no `Auth` is
     * installed). */
    readonly principal: OptionsDef.Principal | null
  }

  export type RawHandler = (
    request: Request,
    params: Readonly<Record<string, string>>,
    context: RawContext,
  ) => Operation<Response>

  /** A raw route served outside the action model (static files, dev consoles). */
  export interface RawRoute {
    readonly method: ServiceDef.HttpMethod | 'OPTIONS' | 'HEAD'
    readonly path: string

    /** Who may reach it, exactly like an action's `auth` (`false` = public). Omitted, the
     * installed `Auth`'s `default` applies — a fail-closed node (`default: 'authenticated'`)
     * keeps raw routes closed too. Without `Auth` installed, anything but `false`/omitted is
     * refused (`server.unauthorized`). */
    readonly auth?: OptionsDef.Requirement | undefined
    readonly handler: RawHandler
  }

  /** `Edge.actions.static(...)`: a directory served under a path prefix. */
  export interface StaticOptions {
    /** the URL prefix, `'/assets'` or `'/assets/**'` (the same). Default `'/'`. */
    readonly path?: string | undefined

    /** the directory served (relative = to the working directory). */
    readonly dir: string

    /** what a directory request serves. Default `'index.html'`; `false` = 404. */
    readonly index?: string | false | undefined

    /** serve dot-files (`.env`, `.git/…`). Default `false` — they answer 404. */
    readonly dotfiles?: boolean | undefined

    /** follow symlinks under `dir` (they may point outside it). Default `false` — a path that
     * crosses one answers 404. */
    readonly followSymlinks?: boolean | undefined

    /** the routes' requirement — see {@link RawRoute.auth} (omitted = `Auth`'s default). */
    readonly auth?: OptionsDef.Requirement | undefined
  }

  export interface Actions {
    listen(options?: ListenOptions): Operation<ListenInfo>
    stop(): Operation<void>

    /** Reject new requests with 503 (drain) / accept again. */
    pause(): Operation<void>
    resume(): Operation<void>

    /** Mount every action route of the installed server (runs at `listen`; idempotent). */
    mount(): Operation<number>

    /** Rebuild the routing tables from the kernel's CURRENT registry — what `reload` calls
     * after swapping the declarations. Raw routes, socket routes, decorators and the preflight
     * handler registered through the actions below are kept; open sockets stay open (their
     * handlers already run). Resolves the number of action + socket routes mounted. */
    remount(): Operation<number>
    raw(route: RawRoute): Operation<void>

    /** Serve the files of a directory under a prefix (GET + HEAD, as raw routes — the same
     * `auth` gate): content-type by extension, `..` / escapes refused, 404 for missing files,
     * the `index` file for directories. */
    static(options: StaticOptions): Operation<void>
    socket(route: SocketRoute): Operation<void>
    decorate(decorator: Decorator): Operation<void>
    preflight(handler: Preflight): Operation<void>

    /** Handle one request in-process — what the drivers call, and what tests use without a
     * port. */
    handle(request: Request): Operation<Response>
    info(): Operation<ListenInfo | null>
  }

  // --- driver ---------------------------------------------------------------------------------

  /** What an upgrade hands the engine: a socket the engine drives. */
  export interface RawSocket {
    send(data: string | Uint8Array): void
    close(code?: number, reason?: string): void
    readonly onMessage: (listener: (data: string | Uint8Array) => void) => void
    readonly onClose: (listener: (code: number, reason: string) => void) => void
  }

  /** What the engine decides about a websocket upgrade request. */
  export type Upgrade =
    | { readonly kind: 'accept'; readonly attach: (socket: RawSocket) => void }
    | { readonly kind: 'reject'; readonly response: Response }

  /** The promise-land bridge a driver wires its runtime to. */
  export interface ServeHandlers {
    /** Handle one HTTP request (the response body may still be streaming when it resolves — the
     * engine keeps the request's scope alive until the body is done). */
    fetch(request: Request): Promise<Response>

    /** Decide an upgrade request: accept (then perform the runtime upgrade and `attach` the raw
     * socket) or reject with a response. */
    upgrade(request: Request): Promise<Upgrade>

    /** Whether a request targets a socket route (so the driver knows to try an upgrade). */
    isSocket(request: Request): boolean
  }

  export interface Driver {
    readonly runtime: string
    serve(options: ListenOptions, handlers: ServeHandlers): Operation<ListenInfo>
    stop(): Operation<void>
  }
}
