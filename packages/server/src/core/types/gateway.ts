import type { Future, Operation, Scope, Stream, Task } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Action } from './action'
import type { Service } from './service'

/** The transport-agnostic response envelope an action can read/mutate via useResponse(). */
export interface ActionResponse {
  status: number | null

  meta: Record<string, string> // headers
  body: unknown
}

/**
 * A streaming-response sink the gateway installs (via `ResponseSinkContext`) so a transport can hand
 * an action's byte `Stream` back to the gateway for streaming. `respond` builds the `Response`
 * through the normal `fromInternal` transformer (so cors and other response hooks apply), delivers it
 * to the platform handler immediately, then drains `stream` into the body. The transport `yield*`s it
 * INSIDE the action's scope, so the producer (and any in-flight upstream request) stays alive until
 * the body is fully sent, paced by backpressure.
 */
export interface ResponseSink {
  respond(stream: Stream<Uint8Array, unknown>): Operation<void>
}

/** The transport-agnostic request envelope an action reads via useRequest(). */
export interface ActionRequest {
  type: 'http' | 'ws' | 'rpc' | 'internal'
  method: string // GET, POST, WS, NATS...
  url: URL

  meta: Record<string, string> // headers
}

/**
 * The single web protocol. It gathers the lifecycle, routing, REST-transformer and WS-transformer
 * signatures under one surface so a platform impl (BunGateway / NodeGateway) owns its own server,
 * router, rest and ws internally — and so plugins (cors/docs/auth) hook ONE protocol: e.g. cors does
 * `Gateway.before({ *fromInternal })` and `Gateway.actions.mount(...)`. The gateway's request
 * pipeline calls the hookable actions via `Gateway.actions.*` so those hooks fire.
 */
export namespace GatewayDef {
  /** Per-route REST settings authored on an action via `Gateway.actions.rest({...})`. */
  export interface RestOptions {
    /**
     * Marks an event-stream route. Set by `Gateway.actions.sse(...)`, not by an author.
     *
     * It exists so the `?token=` promotion can be scoped to exactly the clients that cannot send a
     * header — see `toInternalAction`.
     */
    sse?: boolean

    method: string
    path: string
    statusMap?: Record<string, number>
  }

  /**
   * How a WS route treats inbound frames.
   *
   * `message` (default) — every frame is an independent request/response dispatch. Stateless, and
   * each frame may be answered by a different node.
   *
   * `session` — ONE dispatch for the whole connection: the action reads inbound frames off its
   * input stream and answers with a stream of outbound frames. A dispatch is answered by exactly
   * one node and its lanes are keyed to that call, so every frame of a connection lands on the same
   * process — affinity comes from the transport, not from a routing table. The gateway just holds
   * the socket, which is what lets a WS route live in another pod.
   */
  export type WsMode = 'message' | 'session'

  /** Per-route WebSocket settings authored on an action via `Gateway.actions.ws({...})`. */
  export interface WsOptions {
    path: string
    mode?: WsMode
    onOpen?: (ws: unknown) => Operation<void>
    /**
     * Opt-in raw-frame handler. When set, incoming frames on this route go to `onMessage` (the app
     * owns the socket, socket.io-style) instead of the default per-message request/response dispatch.
     * Leave it unset to keep the automatic per-message RPC behaviour.
     */
    onMessage?: (ws: unknown, message: unknown) => Operation<void>
    onClose?: (ws: unknown, code: number, reason: string) => Operation<void>
  }

  /**
   * A `session` connection's out-of-band command to its gateway.
   *
   * Sockets only ever exist on a gateway. A session action may run in another pod entirely, so when
   * it says `socket.join('lobby')` the call cannot touch a registry — it rides back on the
   * connection's OWN outbound stream tagged `$ozaco:gw`, and the gateway applies it without ever
   * forwarding it to the client. Same channel as the data, so ordering with `socket.send` is free
   * and there is no second transport to configure.
   */
  export interface ControlFrame {
    /**
     * `ping` is the LEASE, travelling in both directions and carrying nothing: the gateway sends it
     * inbound so the owner knows the gateway still holds the socket, and the owner sends it
     * outbound so the gateway knows the owner is still there. Neither side can infer the other's
     * death from a quiet stream, so silence is what has to reap a session — and that only works if
     * both ends keep speaking.
     */
    '$ozaco:gw': 'join' | 'leave' | 'toRoom' | 'broadcast' | 'emit' | 'ping'
    room?: string
    to?: string
    message?: unknown
  }

  /** One `session`-mode connection proxied to its owning node: the inbound frame sink plus the task
   * pumping the reply stream back. Closing it halts the pump, which unwinds the dispatch. */
  export interface Channel {
    push(frame: unknown): Operation<void>
    close(): Operation<void>
  }

  /** A live WebSocket connection tracked in the gateway registry (platform-agnostic: Bun + Node). */
  export interface GatewaySocket {
    readonly id: string
    /** rooms this socket has joined — the reverse index used to reap it from every room on close. */
    readonly rooms: Set<string>
    /** background tasks bound to this socket (e.g. `socket.spawn` subscription pumps) — all halted on close. */
    readonly tasks: Set<Task<unknown>>
    /** the underlying platform socket (Bun `ServerWebSocket` / node `ws` `WebSocket`). */
    readonly raw: AnyType
    send(data: string | ArrayBufferView | ArrayBuffer): void
  }

  /** The effect-native socket handle passed to every `Gateway.actions.listen` handler. All methods are
   * scoped to THIS socket (except `toRoom`/`broadcast`, which fan out) and reuse the room registry. */
  export interface Socket {
    readonly id: string
    /** Per-connection data captured at upgrade (headers, url, params). */
    readonly data: AnyType
    /** Rooms this socket is currently in. */
    readonly rooms: Set<string>
    /** Send a message to THIS socket. */
    send(message: unknown): Operation<void>
    /** Add / remove THIS socket to / from a room. */
    join(room: string): Operation<void>
    leave(room: string): Operation<void>
    /** Fan a message out to a room, or to every connected socket. */
    toRoom(room: string, message: unknown): Operation<void>
    broadcast(message: unknown): Operation<void>
    /** Push to ONE other socket by id — a no-op when no gateway currently holds it. */
    emit(socketId: string, message: unknown): Operation<void>
    /**
     * Spawn a background task bound to THIS socket's lifetime — automatically halted when the socket
     * closes. Use it to pump a long-lived source (e.g. a db LiveQuery Stream) into the socket without
     * leaking the loop after disconnect.
     *
     * Returns the task, so a caller tracking several pumps on one socket (per-subscription feeds)
     * can halt exactly one without tearing down the connection.
     */
    spawn(operation: () => Operation<void>): Operation<Task<void>>
  }

  /**
   * Handlers for `Gateway.actions.listen` — a WS endpoint registered WITHOUT `defineAction`/`mount`.
   * `message` is the raw catch-all (every frame); `on` is a socket.io-style event map — an inbound
   * `{ event, ... }` whose `event` matches an `on` key routes there, anything else falls to `message`.
   */
  export interface ListenHandlers {
    open?: (socket: Socket) => Operation<void>
    message?: (socket: Socket, message: unknown) => Operation<void>
    close?: (socket: Socket) => Operation<void>
    on?: Record<string, (socket: Socket, message: AnyType) => Operation<void>>
  }

  /** The marker a resolved transformer setting carries so the router can classify it. */
  export interface TransformerSetting {
    method: string
    path: string
    transformer: AnyType
  }

  /** Everything the gateway's fetch/ws handler needs to dispatch a matched route. */
  export interface TransformerMeta {
    sym: symbol
    key?: string
    prefix: string
    target: Action | Service
    setting: TransformerSetting & Partial<RestOptions> & Partial<WsOptions>
    params: Record<string, unknown>
  }

  /** A route entry in the gateway's handlers map; captures the concrete Action for dispatch. */
  export interface RegisteredRoute {
    sym: symbol
    key?: string
    prefix: string
    setting: TransformerSetting & Partial<RestOptions> & Partial<WsOptions>
    target: Action | Service
    action: Action
  }

  /** One context holds the listener state + the route table (rou3). */
  export interface Context {
    port: number
    host: string

    /** The gateway's install scope — where per-socket `socket.spawn` tasks run (halted on close). */
    scope: Scope

    server: AnyType
    started: boolean
    paused: false | string

    router: AnyType
    compiled: (method: string, path: string) => AnyType
    handlers: Map<symbol, RegisteredRoute>

    /** Live WS connections by id, and room name → member socket ids (socket.io-style groups). Both are
     * populated by the WS lifecycle (onOpen/onClose) and read by the emit/broadcast/room actions. */
    sockets: Map<string, GatewaySocket>
    rooms: Map<string, Set<string>>

    /** Open `session`-mode proxies by socket id: the upstream dispatch this connection is bound to. */
    channels: Map<string, Channel>

    /** The `WS_MODE` env override, or null when unset. It may upgrade routes that declared no mode,
     * so a split deployment can turn on socket proxying without editing any service — but it can
     * neither downgrade an explicit `session` route nor upgrade a raw `listen()` endpoint. */
    wsMode: WsMode | null

    /** in-flight background request tasks (streaming pumps live here); halted on destroy so an
     * active stream cannot block shutdown — halting aborts the pump + its upstream fetch */
    inflight: Set<Task<unknown>>

    statusMap?: Record<string, number> | undefined
    maxBodyBytes?: number | undefined
    reusePort?: boolean | undefined

    simplify?:
      | ((failure: Result.Failure<unknown>) => Operation<Result.Failure<unknown>>)
      | undefined
  }

  export interface Options {
    port?: number
    host?: string
    statusMap?: Record<string, number>
    maxBodyBytes?: number
    reusePort?: boolean

    simplify?:
      | ((failure: Result.Failure<unknown>) => Operation<Result.Failure<unknown>>)
      | undefined
  }

  export interface Actions {
    // listener lifecycle
    start(
      options: Partial<{ port: number; host: string; reusePort: boolean }>,
    ): Future<{ port: number; host: string }>
    isStarted(): Future<boolean>
    pause(cause: string): Future<void>
    isPaused(): Future<false | string>
    resume(): Future<void>
    destroy(options?: { drainMs?: number }): Future<void>

    // routing (rou3)
    add(method: string, pattern: string, payload: symbol): Future<void>
    remove(method: string, pattern: string): Future<void>
    has(method: string, pattern: string, payload?: symbol): Future<boolean>
    find(method: string, path: string): Future<[data: symbol, params?: unknown]>
    optimize(): Future<void>
    mount(prefix: string, target: Service | Action): Future<void>
    unmount(target: Service | Action): Future<void>

    // rest transformer (toInternal/fromInternal are the cors/plugin hook points)
    toInternal(
      req: unknown,
      res: unknown,
      meta: unknown,
    ): Future<[req: ActionRequest, res: ActionResponse, body: unknown]>
    fromInternal(
      req: ActionRequest | null,
      res: ActionResponse | null,
      ret: Result<unknown, unknown>,
      meta: unknown,
    ): Future<AnyType>
    rest<T extends RestOptions>(options: T): Future<T & { transformer: AnyType }>

    // ws transformer (route-bound)
    upgrade(req: unknown, runtime: unknown): Future<boolean>
    onOpen(ws: unknown): Future<void>
    onMessage(ws: unknown, message: unknown): Future<void>
    onClose(ws: unknown, code: number, reason: string): Future<void>
    ws<T extends WsOptions>(options: T): Future<T & { method: string; transformer: AnyType }>

    // realtime push + rooms — server-initiated, callable from ANY scope (not just an action's return).
    // `join`/`leave` act on the CURRENT socket (must run inside a WS request); the rest target by id/room.
    emit(socketId: string, message: unknown): Future<void>
    broadcast(message: unknown): Future<void>
    join(room: string): Future<void>
    leave(room: string): Future<void>
    toRoom(room: string, message: unknown): Future<void>

    /** Register a WebSocket endpoint at `path` WITHOUT defineAction/mount; handlers get a {@link Socket}. */
    listen(path: string, handlers: ListenHandlers): Future<void>

    /** Register a GET Server-Sent-Events endpoint at `path`; handlers get a one-way {@link Socket}
     * (server→client push). The SSE alternative to `listen` for environments without WebSockets. */
    sse(path: string, handlers: ListenHandlers): Future<void>
  }

  export type Default = Plugin<GatewayDef.Context, [options?: GatewayDef.Options], Actions>

  export type WsSetting = GatewayDef.TransformerSetting & Partial<GatewayDef.WsOptions>
}
