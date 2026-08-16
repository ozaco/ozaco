import type { BoundLogger, Lease } from 'server:utils'
import { createContext } from 'std:effect'
import type { Context, Scope, Task } from 'std:effect'

import type { RouterContext } from 'rou3'

import type { Action } from '../../types/action'
import type {
  Edge,
  EdgeDecorator,
  EdgePreflight,
  SocketHandle,
  SocketRoute,
} from '../../types/gateway'
import type { Service } from '../../types/service'

import type { SocketRegistry } from './sockets'

export interface RouteTarget {
  readonly service: Service
  readonly actionKey: string
  readonly action: Action
}

export interface SocketBinding {
  readonly route: SocketRoute
  readonly handle: SocketHandle
  readonly lease?: Lease | undefined
  readonly watch?: Task<unknown> | undefined
}

export interface GatewayCtx {
  readonly name: string
  readonly gatewayId: string
  readonly debug: boolean
  readonly maxBodyBytes: number
  readonly router: RouterContext<RouteTarget>
  readonly socketRouter: RouterContext<SocketRoute>
  readonly mounts: Map<string, Service>
  readonly bindings: Map<string, SocketBinding>
  readonly sockets: SocketRegistry
  readonly decorators: EdgeDecorator[]
  readonly hooks: { preflight?: EdgePreflight | undefined }
  readonly log: BoundLogger
  readonly scope: Scope
  readonly idle?: { readonly ttlMs: number; readonly pingMs: number } | undefined
  readonly state: {
    server?: Edge.Server | undefined
    started: boolean
    paused: boolean
    inflight: number
  }
}

export const GatewayRef: Context<GatewayCtx> = createContext<GatewayCtx>('server:core:gateway')
