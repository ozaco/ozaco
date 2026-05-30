import type { Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { POLICY_SETTING } from '../const'

import type { Action } from './action'
import type { TransportDef } from './transport'

export type PolicyDef = Plugin<PolicyDef.Context, unknown, unknown[], PolicyDef.Actions>

export namespace PolicyDef {
  export interface Options {
    name?: string
    priority?: number
  }

  export interface Context {
    name: string
    priority: number
  }

  export interface Setting<T = unknown> {
    _t: typeof POLICY_SETTING
    policy: string
    disabled?: boolean
    value?: Partial<T>
  }

  export interface ConfigActions<TOptions> {
    config(options?: Partial<TOptions>): Future<Setting<TOptions>, unknown>
    disable(): Future<Setting<TOptions>, unknown>
  }

  export interface DispatchContext {
    req: TransportDef.DispatchRequest
    serviceName: string
    actionKey: string
    action: Action.Meta<unknown> | undefined
    params: ReadonlyArray<unknown>
    key: string
    isStreaming: boolean
  }

  export type Next<T> = () => Operation<T, unknown>

  export interface Actions {
    apply<T>(ctx: DispatchContext, next: Next<T>): Future<T, unknown>
    config?(options?: AnyType): Future<Setting<AnyType>, unknown>
    disable?(): Future<Setting<AnyType>, unknown>
  }

  export interface Handlers {
    dispatchRoot<T>(ctx: DispatchContext, core: Next<T>): Future<T, unknown>

    register(policy: PolicyDef, entryCtx: PolicyDef.Context): Future<void, unknown>
    unregister(policy: PolicyDef): Future<void, unknown>
    getPolicies(): Future<PolicyDef[], unknown>
  }
}
