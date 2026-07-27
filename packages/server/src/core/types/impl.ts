import type { Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, EmptyType } from 'std:shared'

import type { Action } from './action'
import type { Channel } from './channel'
import type { PolicyDef } from './policy'
import type { Service } from './service'
import type { SocketService } from './socket'

export namespace Impl {
  /** What an author may state about an action, minus the parts `defineAction` derives. */
  export interface ActionConfig<TInput, TOutput> {
    title?: string
    description?: string

    input?: TInput
    output?: TOutput

    /** surface claims and policy overrides alike, each an operation resolved when it is read */
    settings?: Future<unknown>[]
  }

  export type DefineAction = {
    /**
     * The everyday form. `input` is usually a bare schema, which means one `normal` value channel —
     * and that channel's value is what the handler receives. Any OTHER channel the action declares
     * (a byte lane, a socket) is taken inside the body with `useSource`, so adding one never
     * changes this signature.
     */
    <TInput extends Channel.Declaration, TOutput extends Channel.Declaration, TReturn = unknown>(
      config: ActionConfig<TInput, TOutput>,
      handler: (body: Channel.Body<TInput>) => Operation<TReturn>,
    ): Action<[Channel.Body<TInput>], TReturn>

    /** No declaration at all — a plain internal action nothing needs to describe. */
    <TArgs extends AnyType[], TReturn>(
      handler: (...args: TArgs) => Operation<TReturn>,
    ): Action<TArgs, TReturn>
  }

  export type DefineService = <
    TContext,
    TArgs extends unknown[] = [],
    TActions extends EmptyType = EmptyType,
  >(options: {
    name: string
    version: string
    description?: string

    actions: TActions

    setup?: (...args: TArgs) => Operation<TContext>
  }) => Service<TContext, TArgs, TActions>

  /** `defineService`'s sibling for a live connection — fixed actions (`connect`), pinned install
   * args, handlers instead of an actions record. See {@link SocketService}. */
  export type DefineSocket = (
    config: SocketService.Config,
    handlers: SocketService.Handlers,
  ) => SocketService

  export interface PolicyApplyArgs<TOptions, TContext> {
    /** the resolved dispatch context (request, service/action, key, isStreaming, settings) */
    dispatch: PolicyDef.DispatchContext
    /** the policy's live context, already typed — no `useContext` cast at the call site */
    ctx: TContext
    /** the per-action override (`SomePolicy.actions.config(...)`), if any */
    override: Partial<TOptions> | undefined
    /** the inner dispatch (next policy / core). Returns the dispatch value or throws a failure. */
    next: PolicyDef.Next<unknown>
  }

  export interface PolicySpec<
    TOptions extends PolicyDef.Options,
    TContext extends PolicyDef.Context,
  > {
    /** the per-action setting key used by `config`/`disable` and `findPolicySetting` */
    key: string
    /** plugin name, e.g. `server/policy-retry` */
    name: string
    /** context name used for registry de-duplication, e.g. `policy/retry` */
    contextName: string
    /** default onion priority (lower = outer). Use `PolicyPriority`. */
    priority: number
    version?: string
    /** build the policy's context; `base` carries the resolved name + priority to spread in */
    setup(options: TOptions | undefined, base: PolicyDef.Context): Operation<TContext>
    /** the policy behaviour, invoked only when the policy is enabled for this action */
    apply(args: PolicyApplyArgs<TOptions, TContext>): Operation<unknown>
    /** synchronous cleanup on uninstall (clear timers, reject waiters, …) */
    teardown?(ctx: TContext): void
  }

  /**
   * a built policy whose install options AND `config`/`disable` are type-checked against its own
   * options (the base `PolicyDef` widens setup args to `unknown[]`, which would drop install typing)
   */
  export type Policy<TOptions extends PolicyDef.Options> = Plugin<
    PolicyDef.Context,
    [options?: TOptions],
    // omit the loose `config?(options?: AnyType)` / `disable?()` from the base actions so the
    // precisely-typed signatures below win overload resolution (and callbacks get inferred)
    Omit<PolicyDef.Actions, 'config' | 'disable'> & {
      config(options?: Partial<TOptions>): Future<PolicyDef.Setting<TOptions>>
      disable(): Future<PolicyDef.Setting<TOptions>>
    }
  >
}
