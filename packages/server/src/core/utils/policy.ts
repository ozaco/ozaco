import type { Future, Operation } from 'std:effect'

import { POLICY_SETTING } from '../const'
import type { Action } from '../types/action'
import type { PolicyDef } from '../types/policy'

const isPolicySetting = (value: unknown): value is PolicyDef.Setting =>
  typeof value === 'object' && value !== null && (value as { _t?: unknown })._t === POLICY_SETTING

/**
 * Disable several policies for one action in a single `settings` entry. Useful because policies
 * are independent — e.g. disabling the cache does NOT disable request coalescing — so a "fresh"
 * read bypasses both: `defineAction({ settings: bypass(CachePolicy, BucketPolicy) }, ...)`.
 */
export const bypass = (
  ...policies: ReadonlyArray<PolicyDef.DisableablePolicy>
): Future<PolicyDef.Setting<unknown>>[] => policies.map(policy => policy.actions.disable())

/**
 * Resolve an action's lazy per-policy settings ONCE per dispatch into a `policy -> setting` map.
 * Each setting is a `Future` that runs through the plugin hook chain; resolving them once (instead
 * of re-resolving every setting inside every policy's apply) is O(settings) rather than
 * O(policies × settings), and a setting whose target policy is not installed is skipped instead of
 * failing the dispatch of unrelated policies.
 */
export const resolvePolicySettings = function* (
  action: Action.Meta<unknown> | undefined,
): Operation<Map<string, PolicyDef.Setting>> {
  const settings = new Map<string, PolicyDef.Setting>()
  for (const op of action?.settings ?? []) {
    let resolved: unknown
    try {
      resolved = yield* op
    } catch {
      continue
    }
    if (isPolicySetting(resolved)) {
      settings.set(resolved.policy, resolved)
    }
  }
  return settings
}

/** O(1) lookup of a setting already resolved by {@link resolvePolicySettings} */
export const findPolicySetting = <T>(
  dispatchCtx: PolicyDef.DispatchContext,
  policyKey: string,
): PolicyDef.Setting<T> | undefined =>
  dispatchCtx.settings.get(policyKey) as PolicyDef.Setting<T> | undefined

export const makePolicySetting = <T>(
  policyKey: string,
  payload: { disabled: true } | { value: Partial<T> },
): PolicyDef.Setting<T> => ({
  _t: POLICY_SETTING,
  policy: policyKey,
  ...payload,
})
