import type { Flow, Operation } from 'std:effect'
import type { Result } from 'std:result'

import type { Meta } from './common'
import type { Service } from './service'

/** Install-time engine options. */
export interface GatewayOptions {
  /** The hop name recorded in lanes (default `gateway`). */
  readonly name?: string | undefined
  /** Include failure cause chains in HTTP error bodies (never enable in production). */
  readonly debug?: boolean | undefined
  /** Max buffered request body bytes (default 16 MiB). */
  readonly maxBodyBytes?: number | undefined
  /**
   * Per-socket liveness lease: any inbound frame or pong renews it; expiry closes the socket
   * (4000 'idle timeout') and reaps its watches — the half-open/dead-peer guard. `false` disables;
   * default `{ ttlMs: 60_000, pingMs: 20_000 }` (browsers answer protocol pings automatically).
   */
  readonly idle?:
    | false
    | { readonly ttlMs?: number | undefined; readonly pingMs?: number | undefined }
    | undefined
}

export interface GatewayServeOptions {
  readonly port?: number | undefined
  readonly host?: string | undefined
}

export interface GatewayInfo {
  readonly port: number
  readonly host: string
  readonly url: string
}

/**
 * The edge ENGINE — one implementation in core (`DefaultGateway`): router, REST/SSE/multipart
 * transforms, WebSocket sessions, rooms, request-id echo, pause/drain. Per-runtime adapters
 * implement {@link GatewayAdapterActions} only.
 */
export interface GatewayActions {
  start(options?: GatewayServeOptions): Operation<GatewayInfo>
  stop(): Operation<void>
  isStarted(): Operation<boolean>
  pause(): Operation<void>
  resume(): Operation<void>
  /** Registers every routed action of the service under the prefix. */
  mount(prefix: string, service: Service): Operation<void>
  unmount(prefix: string): Operation<void>
  /** A raw WebSocket endpoint (wizard realtime, docs panel live view, custom protocols). */
  socket(path: string, route: SocketRoute): Operation<void>
  /** Registers a response decorator applied to EVERY edge response (CORS headers etc.). */
  decorate(decorator: EdgeDecorator): Operation<void>
  /** Handles OPTIONS requests that matched no route (CORS preflight). */
  preflight(handler: EdgePreflight): Operation<void>
  info(): Operation<GatewayInfo>
}

/** Pure response decorator — must not throw. */
export type EdgeDecorator = (request: EdgeRequest, response: EdgeResponse) => EdgeResponse

/** Returns a response to short-circuit an unrouted OPTIONS request, or undefined to fall through. */
export type EdgePreflight = (request: EdgeRequest) => Operation<EdgeResponse | undefined>

/** A platform-neutral inbound request at the edge (`url` = path + query, e.g. `/todos/1?x=2`). */
export interface EdgeRequest {
  readonly method: string
  readonly url: string
  readonly headers: Meta
  readonly body?: Flow<Uint8Array, unknown> | undefined
}

/** A platform-neutral response the engine hands back to the adapter. */
export interface EdgeResponse {
  readonly status: number
  readonly headers: Meta
  readonly body?: Uint8Array | Flow<Uint8Array, unknown> | undefined
}

/** The adapter-facing edge plumbing (types-only namespace) — engine ↔ runtime adapter contract. */
export namespace Edge {
  export interface Handlers {
    fetch(request: EdgeRequest): Operation<EdgeResponse>
    /** The single upgrade path — one handshake, one 401/404 semantic, every runtime. */
    upgrade(request: EdgeRequest): Operation<Upgrade>
  }

  export type Upgrade =
    | { readonly kind: 'accept'; readonly handlers: SocketHandlers }
    | { readonly kind: 'reject'; readonly status: number; readonly headers?: Meta | undefined }

  export interface SocketHandlers {
    open(socket: Socket): Operation<void>
    message(socket: Socket, data: string | Uint8Array): Operation<void>
    close(socket: Socket, code: number, reason: string): Operation<void>
    /** Protocol pong received — renews the idle lease. Optional for adapters without ping. */
    pong?(socket: Socket): Operation<void>
  }

  /** What the adapter exposes per live connection. */
  export interface Socket {
    readonly id: string
    send(data: string | Uint8Array): void
    close(code?: number, reason?: string): void
    /** Protocol-level ping when the runtime supports it (bun/node `ws`; absent on deno). */
    ping?(): void
  }

  export interface Server {
    readonly port: number
    readonly host: string
    stop(): Operation<void>
  }
}

/** The ONLY thing a runtime adapter (bun/node/deno) implements: serve + upgrade + socket I/O. */
export interface GatewayAdapterActions {
  serve(options: GatewayServeOptions, edge: Edge.Handlers): Operation<Edge.Server>
}

/** The engine-level connection handle a {@link SocketRoute} works with. */
export interface SocketHandle {
  readonly id: string
  /** Upgrade-request headers (authorization included — `?token=` is promoted by the engine). */
  readonly meta: Meta
  readonly params: Record<string, string>
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  join(room: string): void
  leave(room: string): void
  /** Local room delivery + cross-replica fanout over `Broker.broadcast`. */
  toRoom(room: string, data: string | Uint8Array): Operation<void>
  broadcast(data: string | Uint8Array): Operation<void>
}

export interface SocketRoute {
  /** Refuse BEFORE the socket exists (→ 401). Return false to reject. */
  readonly authorize?: ((request: EdgeRequest) => Operation<boolean>) | undefined
  readonly open?: ((socket: SocketHandle) => Operation<void>) | undefined
  readonly message: (socket: SocketHandle, data: string | Uint8Array) => Operation<void>
  readonly close?:
    | ((socket: SocketHandle, code: number, reason: string) => Operation<void>)
    | undefined
}

/** How multipart flows close: clean end, or a Failure when the producer side broke. */
export type PartClose = true | Result.Failure<unknown>

/** One multipart plane item — fields arrive before files by construction. */
export type Part =
  | { readonly kind: 'field'; readonly name: string; readonly value: string }
  | {
      readonly kind: 'file'
      readonly name: string
      readonly filename: string
      readonly contentType: string
      readonly data: Flow<Uint8Array, PartClose>
    }

/** What `useSource(DataType.multistream)` yields on multipart dispatches. */
export interface Multistream {
  readonly parts: Flow<Part, PartClose>
}
