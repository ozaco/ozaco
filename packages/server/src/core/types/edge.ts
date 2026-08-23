import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { ServerDef } from './server'
import type { ServiceDef } from './service'

/**
 * The edge protocol: the HTTP/WebSocket face of a server. The ENGINE (routing, body parsing,
 * branded stream bodies, SSE, sockets, request ids, decorators) lives in core over the web
 * `Request`/`Response` types; an impl is one thin driver: how to listen on this runtime.
 */
export namespace EdgeDef {
  export interface Options {
    readonly runtime: string
  }

  export interface ListenOptions {
    readonly port?: number | undefined
    readonly hostname?: string | undefined
  }

  export interface ListenInfo {
    readonly url: string
    readonly port: number
    readonly hostname: string
  }

  /** What a socket route handler receives. */
  export interface Socket {
    readonly id: string
    readonly params: Readonly<Record<string, string>>
    readonly headers: Readonly<Record<string, string>>
    readonly ctx: ServerDef.Ctx

    /** inbound messages (codec values). */
    readonly messages: Flow<unknown, void>
    send(value: unknown): Operation<void>
    close(code?: number, reason?: string): Operation<void>
  }

  export type SocketHandler = (socket: Socket) => Operation<void>

  /** A response decorator: runs on every response (errors included). */
  export type Decorator = (request: Request, response: Response) => Operation<Response>

  /** Answers unrouted OPTIONS requests (CORS preflight); `null` = not handled. */
  export type Preflight = (request: Request) => Operation<Response | null>

  export interface SocketRoute {
    readonly path: string
    readonly handler: SocketHandler

    /** runs before the upgrade; a failure rejects the handshake with its status. */
    readonly authorize?: ((request: Request) => Operation<void>) | undefined

    /** the service this socket belongs to (docs list it under the service). */
    readonly service?: string | undefined

    /** what travels on it, for docs (`resource` = watch/unwatch ↔ sync/delta frames). */
    readonly protocol?: string | undefined
    readonly description?: string | undefined
  }

  /** A mounted socket route as the kernel lists it (docs, manifest). */
  export interface SocketInfo {
    readonly path: string
    readonly service: string | null
    readonly protocol: string | null
    readonly description: string | null
  }

  /** A raw route served outside the action model (static files, dev consoles). */
  export interface RawRoute {
    readonly method: ServiceDef.HttpMethod | 'OPTIONS' | 'HEAD'
    readonly path: string

    readonly handler: (
      request: Request,
      params: Readonly<Record<string, string>>,
    ) => Operation<Response>
  }

  export interface Actions {
    describe(): Operation<Options>
    listen(options?: ListenOptions): Operation<ListenInfo>
    stop(): Operation<void>

    /** Reject new requests with 503 (drain) / accept again. */
    pause(): Operation<void>
    resume(): Operation<void>

    /** Mount every action route of the installed server (runs at `listen`; idempotent). */
    mount(): Operation<number>
    raw(route: RawRoute): Operation<void>
    socket(route: SocketRoute): Operation<void>
    decorate(decorator: Decorator): Operation<void>
    preflight(handler: Preflight): Operation<void>

    /** Handle one request in-process — what the drivers call, and what tests use without a
     * port. */
    handle(request: Request): Operation<Response>
    info(): Operation<ListenInfo | null>
  }

  export type Defaults = Pick<Actions, 'describe'>

  export type Handle = Plugin<Options, AnyType[], Actions>

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
