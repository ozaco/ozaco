import type { PolicyDef } from 'server:core'
import { findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, useContext } from 'std:effect'
import { asFailure } from 'std:result'

import { FallbackPolicyKey } from './types'
import type { Fallback } from './types'
import { getSelf } from './utils'

export const FallbackPolicy = Policy.implement({
  name: 'server/policy-fallback',
  version: '0.0.0',
  *setup(options?: Fallback.Options) {
    const context: Fallback.Context = {
      name: options?.name ?? 'policy/fallback',
      priority: options?.priority ?? 5,
      ...(options?.value === undefined ? {} : { value: options.value }),
      ...(options?.handler === undefined ? {} : { handler: options.handler }),
      ...(options?.when === undefined ? {} : { when: options.when }),
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<Fallback.Options>) {
    return makePolicySetting<Fallback.Options>(FallbackPolicyKey, { value: options ?? {} })
  }),
  disable: operation(function* () {
    return makePolicySetting<Fallback.Options>(FallbackPolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    if (dispatchCtx.isStreaming) {
      return yield* next()
    }

    const setting = yield* findPolicySetting<Fallback.Options>(dispatchCtx, FallbackPolicyKey)
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as Fallback.Context
    const handler = override?.handler ?? ctx.handler
    const when = override?.when ?? ctx.when
    // distinguish "configured value" (presence) from "value is undefined"; an action may
    // intentionally configure a fallback of `undefined`, or override a global value with one
    const overrideHasValue = override !== undefined && 'value' in override
    const hasValue = overrideHasValue || 'value' in ctx
    const fallbackValue = overrideHasValue ? override.value : ctx.value

    try {
      return yield* next()
    } catch (error) {
      // any thrown value is treated as a failure — a raw error is wrapped into one via asFailure
      const failure = asFailure(error)
      if (when && !when(failure)) {
        throw failure
      }

      if (handler) {
        return (yield* handler(failure, dispatchCtx)) as T
      }
      if (hasValue) {
        return fallbackValue as T
      }
      throw failure
    }
  }),
})
