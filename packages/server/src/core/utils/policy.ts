import type { Operation } from 'std:effect'

import { POLICY_SETTING } from '../const'
import type { PolicyDef } from '../types/policy'

const isPolicySetting = (value: unknown): value is PolicyDef.Setting =>
  typeof value === 'object' && value !== null && (value as { _t?: unknown })._t === POLICY_SETTING

export const findPolicySetting = function* <T>(
  dispatchCtx: PolicyDef.DispatchContext,
  policyKey: string,
): Operation<PolicyDef.Setting<T> | undefined, unknown> {
  for (const op of dispatchCtx.action?.settings ?? []) {
    let resolved: unknown
    try {
      resolved = yield* op
    } catch {
      // a setting whose target policy is not installed cannot resolve through the hook chain;
      // skip it rather than failing the dispatch of unrelated policies
      continue
    }
    if (isPolicySetting(resolved) && resolved.policy === policyKey) {
      return resolved as PolicyDef.Setting<T>
    }
  }
  return undefined
}

export const makePolicySetting = <T>(
  policyKey: string,
  payload: { disabled: true } | { value: Partial<T> },
): PolicyDef.Setting<T> => ({
  _t: POLICY_SETTING,
  policy: policyKey,
  ...payload,
})
