import { filter, operation, some, toSorted, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { PolicyDef } from '../types/policy'

import { PolicyRegistryContext } from './context'

export const sortedPolicies = operation(function* (entries: PolicyDef[]) {
  return yield* toSorted(entries, function* (a, b) {
    const aCtx = yield* useContext(a)
    const bCtx = yield* useContext(b)

    return aCtx.priority - bCtx.priority
  })
})

export const policyDispatch = operation(function* <T>(
  ctx: PolicyDef.DispatchContext,
  core: PolicyDef.Next<T>,
) {
  const entries = yield* policyGetPoliciesHandler()

  let chain: PolicyDef.Next<T> = core
  for (let i = entries.length - 1; i >= 0; i--) {
    const policy = entries[i]!
    const inner = chain
    chain = function* () {
      return yield* policy.actions.apply<T>(ctx, inner)
    }
  }

  return yield* chain()
})

export const policyRegisterHandler: PolicyDef.Handlers['register'] = operation(
  function* (policy, policyCtx) {
    const existing = yield* policyGetPoliciesHandler()

    if (
      yield* some(existing, function* (target) {
        const targetCtx = yield* useContext(target)

        return targetCtx.name === policyCtx.name
      })
    ) {
      return yield* fail('unexpected', `Policy ${policyCtx.name} is already registered`)
    }

    yield* PolicyRegistryContext.set(yield* sortedPolicies([...existing, policy]))
  },
)

export const policyUnregisterHandler: PolicyDef.Handlers['unregister'] = operation(
  function* (policy) {
    const existing = yield* policyGetPoliciesHandler()
    const policyCtx = yield* useContext(policy)

    yield* PolicyRegistryContext.set(
      yield* filter(existing, function* (target) {
        const targetCtx = yield* useContext(target)

        return targetCtx.name !== policyCtx.name
      }),
    )
  },
)

export const policyGetPoliciesHandler: PolicyDef.Handlers['getPolicies'] = operation(function* () {
  return (yield* PolicyRegistryContext.get()) ?? []
})
