import type { Future, Operation, Stream } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Action } from './action'
import type { Service } from './service'

/** A streamed file extracted from a multipart/form-data body. */
export interface ActionFile {
  name: string
  type: string
  size: number
  lastModified?: number | undefined
  stream: Stream<Uint8Array, AnyType>
}

/** The transport-agnostic response envelope an action can read/mutate via useResponse(). */
export interface ActionResponse {
  status: number | null

  meta: Record<string, string> // headers
  files: Record<string, ActionFile[]>
  body: unknown
}

/** The transport-agnostic request envelope an action reads via useRequest(). */
export interface ActionRequest {
  type: 'http' | 'ws' | 'rpc' | 'internal'
  method: string // GET, POST, WS, NATS...
  url: URL

  meta: Record<string, string> // headers
  files: Record<string, ActionFile[]>
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
    method: string
    path: string
    files?: string[] | RegExp | ((key: string) => boolean)
    statusMap?: Record<string, number>
  }

  /** Per-route WebSocket settings authored on an action via `Gateway.actions.ws({...})`. */
  export interface WsOptions {
    path: string
    onOpen?: (ws: unknown) => Operation<void, unknown>
    onClose?: (ws: unknown, code: number, reason: string) => Operation<void, unknown>
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

    server: AnyType
    started: boolean
    paused: false | string

    router: AnyType
    compiled: (method: string, path: string) => AnyType
    handlers: Map<symbol, RegisteredRoute>

    statusMap?: Record<string, number> | undefined
    maxBodyBytes?: number | undefined

    simplify?:
      | ((failure: Result.Failure<unknown>) => Operation<Result.Failure<unknown>, unknown>)
      | undefined
  }

  export interface Options {
    port?: number
    host?: string
    statusMap?: Record<string, number>
    maxBodyBytes?: number

    simplify?:
      | ((failure: Result.Failure<unknown>) => Operation<Result.Failure<unknown>, unknown>)
      | undefined
  }

  export interface Actions {
    // listener lifecycle
    start(
      options: Partial<{ port: number; host: string }>,
    ): Future<{ port: number; host: string }, unknown>
    isStarted(): Future<boolean, unknown>
    pause(cause: string): Future<void, unknown>
    isPaused(): Future<false | string, unknown>
    resume(): Future<void, unknown>
    destroy(options?: { drainMs?: number }): Future<void, unknown>

    // routing (rou3)
    add(method: string, pattern: string, payload: symbol): Future<void, unknown>
    remove(method: string, pattern: string): Future<void, unknown>
    has(method: string, pattern: string, payload?: symbol): Future<boolean, unknown>
    find(method: string, path: string): Future<[data: symbol, params?: unknown], unknown>
    optimize(): Future<void, unknown>
    mount(prefix: string, target: Service | Action): Future<void, unknown>
    unmount(target: Service | Action): Future<void, unknown>

    // rest transformer (toInternal/fromInternal are the cors/plugin hook points)
    toInternal(
      req: unknown,
      res: unknown,
      meta: unknown,
    ): Future<[req: ActionRequest, res: ActionResponse, body: unknown], unknown>
    fromInternal(
      req: ActionRequest | null,
      res: ActionResponse | null,
      ret: Result<unknown, unknown>,
      meta: unknown,
    ): Future<AnyType, unknown>
    rest<T extends RestOptions>(options: T): Future<T & { transformer: AnyType }, unknown>

    // ws transformer (route-bound)
    upgrade(req: unknown, runtime: unknown): Future<boolean, unknown>
    onOpen(ws: unknown): Future<void, unknown>
    onMessage(ws: unknown, message: unknown): Future<void, unknown>
    onClose(ws: unknown, code: number, reason: string): Future<void, unknown>
    ws<T extends WsOptions>(
      options: T,
    ): Future<T & { method: string; transformer: AnyType }, unknown>
  }

  export type Default = Plugin<GatewayDef.Context, unknown, [options?: GatewayDef.Options], Actions>

  export type WsSetting = GatewayDef.TransformerSetting & Partial<GatewayDef.WsOptions>
}
