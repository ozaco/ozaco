import { definePolicy, PolicyPriority } from 'server:core'
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
      if (when && !when(failure)) {
        yield* failure
      }

      if (handler) {
        return yield* handler(failure, dispatch)
      }
      if (hasValue) {
        return fallbackValue
      }
      yield* failure
    }
  },
})
