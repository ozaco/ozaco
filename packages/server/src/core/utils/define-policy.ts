import { ensure, operation, useContext } from 'std:effect'

import { Policy } from '../definitions'
import { sortedPolicies } from '../internal/policy-router'
import { tracePolicyApply } from '../internal/policy-trace'
import type { Impl } from '../types/impl'
import type { PolicyDef } from '../types/policy'

import { findPolicySetting, makePolicySetting } from './policy'

/**
 * Build a resilience policy without the per-policy boilerplate. Centralises `config`/`disable`,
 * the per-action disable check + override lookup, the typed context access, and
 * register/unregister + teardown — so every policy resolves settings, merges overrides and tears
 * down the same (correct) way.
 */
export const definePolicy = <
  TOptions extends PolicyDef.Options,
  TContext extends PolicyDef.Context,
>(
  spec: Impl.PolicySpec<TOptions, TContext>,
): Impl.Policy<TOptions> => {
  // forward reference to the built policy, resolved before setup/apply ever run (install time)
  // oxlint-disable-next-line prefer-const
  let self: PolicyDef | undefined

  const built = Policy.implement({
    name: spec.name,
    version: spec.version ?? '0.0.0',
    *setup(options?: TOptions) {
      const base: PolicyDef.Context = {
        name: options?.name ?? spec.contextName,
        priority: options?.priority ?? spec.priority,
      }
      const context = yield* spec.setup(options, base)

      yield* Policy.actions.register(self!, context)
      yield* ensure(function* () {
        spec.teardown?.(context)
        yield* Policy.actions.unregister(self!)
      })

      return context
    },
  }).build({
    config: operation(function* (options?: Partial<TOptions>) {
      return makePolicySetting<TOptions>(spec.key, { value: options ?? {} })
    }),
    disable: operation(function* () {
      return makePolicySetting<TOptions>(spec.key, { disabled: true })
    }),
    apply: operation(function* <T>(dispatch: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
      const setting = findPolicySetting<TOptions>(dispatch, spec.key)
      const disabled = setting?.disabled === true

      const runEnabled = function* (innerNext: PolicyDef.Next<unknown>) {
        const ctx = (yield* useContext(self!)) as TContext
        return yield* spec.apply({ dispatch, ctx, override: setting?.value, next: innerNext })
      }

      if (!dispatch.trace) {
        if (disabled) {
          return yield* next()
        }
        return (yield* runEnabled(next as PolicyDef.Next<unknown>)) as T
      }

      return (yield* tracePolicyApply({
        key: spec.key,
        name: spec.contextName,
        priority: spec.priority,
        dispatch,
        disabled,
        next: next as PolicyDef.Next<unknown>,
        apply: runEnabled,
      })) as T
    }),
  })

  self = built
  return built as unknown as Impl.Policy<TOptions>
}

/**
 * Inspect the installed policies in their resolved onion order (outermost first). Read-only — use
 * it to see the layering at runtime (e.g. to confirm timeout sits innermost). Returns an empty
 * array when no policies are installed.
 */
export const describePolicyChain = operation(function* () {
  const ordered = yield* sortedPolicies(yield* Policy.actions.getPolicies())
  const chain: PolicyDef.PolicyChainEntry[] = []
  for (const policy of ordered) {
    const ctx = yield* useContext(policy)
    chain.push({ name: ctx.name, priority: ctx.priority })
  }
  return chain
})
