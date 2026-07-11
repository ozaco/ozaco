import type { Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { Action } from './action'
import type { PolicyDef } from './policy'
import type { Service } from './service'

export namespace Impl {
  export type DefineAction = {
    <TSchema extends StandardSchemaV1, TReturn>(
      config: { input: TSchema } & Partial<Omit<Action.Meta<TSchema>, '_t' | 'input'>>,
      handler: (body: StandardSchemaV1.InferOutput<TSchema>) => Operation<TReturn>,
    ): Action<[StandardSchemaV1.InferOutput<TSchema>], TReturn>

    <TReturn>(
      config: Partial<Omit<Action.Meta<unknown>, '_t' | 'input'>>,
      handler: (body?: unknown) => Operation<TReturn>,
    ): Action<[body?: unknown], TReturn>

    <Args extends AnyType[], T>(fn: (...args: Args) => Operation<T>): Action<Args, T>
  }

  export type DefineService = <
    TContext,
    TArgs extends unknown[] = [],
    TActions = unknown,
  >(options: {
    name: string
    version: string
    description?: string

    actions: TActions

    isPrivate?: boolean

    setup?: (...args: TArgs) => Operation<TContext>
  }) => Service<TContext, TArgs, TActions>

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
