import { definePolicy, PolicyPriority } from 'server:core'
import { retry } from 'std:effect'

import type { Retry } from './types'
import { RetryPolicyKey } from './types'

export const RetryPolicy = definePolicy<Retry.Options, Retry.Context>({
  key: RetryPolicyKey,
  name: 'server/policy-retry',
  contextName: 'policy/retry',
  priority: PolicyPriority.Retry,
  *setup(options, base) {
    return {
      ...base,
      attempts: options?.attempts ?? 3,
      delay: options?.delay ?? 0,
      backoff: options?.backoff ?? 1,
      maxDelay: options?.maxDelay ?? 30_000,
      retryStreams: options?.retryStreams ?? false,
      ...(options?.when === undefined ? {} : { when: options.when }),
    }
  },
  *apply({ dispatch, ctx, override, next }) {
    const retryStreams = override?.retryStreams ?? ctx.retryStreams
    if (dispatch.isStreaming && !retryStreams) {
      return yield* next()
    }

    const when = override?.when ?? ctx.when

    return yield* retry(next, {
      attempts: override?.attempts ?? ctx.attempts,
      delay: override?.delay ?? ctx.delay,
      backoff: override?.backoff ?? ctx.backoff,
      maxDelay: override?.maxDelay ?? ctx.maxDelay,
      ...(when === undefined ? {} : { when }),
    })
  },
})
