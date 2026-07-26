import { definePolicy, PolicyPriority, respondWith, untagged } from 'server:core'
import { asFailure } from 'std:result'

import type { Fallback } from './types'
import { FallbackPolicyKey } from './types'

export const FallbackPolicy = definePolicy<Fallback.Options, Fallback.Context>({
  key: FallbackPolicyKey,
  name: 'server/policy-fallback',
  contextName: 'policy/fallback',
  priority: PolicyPriority.Fallback,
  *setup(options, base) {
    return {
      ...base,
      ...(options?.value === undefined ? {} : { value: options.value }),
      ...(options?.handler === undefined ? {} : { handler: options.handler }),
      ...(options?.when === undefined ? {} : { when: options.when }),
    }
  },
  *apply({ dispatch, ctx, override, next }) {
    if (dispatch.isStreaming) {
      return yield* next()
    }

    const handler = override?.handler ?? ctx.handler
    const when = override?.when ?? ctx.when
    // distinguish "configured value" (presence) from "value is undefined"
    const overrideHasValue = override !== undefined && 'value' in override
    const hasValue = overrideHasValue || 'value' in ctx
    const fallbackValue = overrideHasValue ? override.value : ctx.value

    try {
      return yield* next()
    } catch (error) {
      // any thrown value is treated as a failure — a raw error is wrapped into one via asFailure
      const failure = asFailure(error)

      // `when` and `handler` are application code, so they see the plain tag; `failure` itself is
      // re-raised untouched so whatever the action had already set still reaches the surface.
      const plain = untagged(failure)

      if (when && !when(plain)) {
        yield* failure
      }

      // Both of these are APPLICATION values, so both are wrapped: the onion answers with an
      // envelope, and a policy that substitutes a value must not be the one place that does not.
      if (handler) {
        return respondWith(yield* handler(plain, dispatch))
      }
      if (hasValue) {
        return respondWith(fallbackValue)
      }
      yield* failure
    }
  },
})
