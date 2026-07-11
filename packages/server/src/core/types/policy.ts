import type { Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { POLICY_SETTING } from '../const'

import type { Action } from './action'
import type { TransportDef } from './transport'

export type PolicyDef = Plugin<PolicyDef.Context, unknown[], PolicyDef.Actions>

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
    config(options?: Partial<TOptions>): Future<Setting<TOptions>>
    disable(): Future<Setting<TOptions>>
  }

  export interface DispatchContext {
    req: TransportDef.DispatchRequest
    serviceName: string
    actionKey: string
    action: Action.Meta<unknown> | undefined
    /** per-policy settings resolved once for this dispatch (see `resolvePolicySettings`) */
    settings: ReadonlyMap<string, Setting>
    params: ReadonlyArray<unknown>
    /** the dispatch identity key WITHOUT the caller principal: `service\0action\0params` */
    key: string
    /** the caller-identity discriminator (derived from the request credentials); identity-keying
     * policies (cache/bucket) fold this into their lookup key unless `vary: 'none'` */
    principal: string
    isStreaming: boolean
    /** whether to emit a per-policy-layer trace (log + OTel spans) for this dispatch */
    trace: boolean
  }

  export interface PolicyChainEntry {
    name: string
    priority: number
  }

  export interface DisableablePolicy {
    actions: { disable(): Future<PolicyDef.Setting<unknown>> }
  }

  export type Next<T> = () => Operation<T>

  export interface Actions {
    apply<T>(ctx: DispatchContext, next: Next<T>): Future<T>
    config?(options?: AnyType): Future<Setting<AnyType>>
    disable?(): Future<Setting<AnyType>>
  }

  export interface Handlers {
    dispatchRoot<T>(ctx: DispatchContext, core: Next<T>): Future<T>

    register(policy: PolicyDef, entryCtx: PolicyDef.Context): Future<void>
    unregister(policy: PolicyDef): Future<void>
    getPolicies(): Future<PolicyDef[]>
  }
}
