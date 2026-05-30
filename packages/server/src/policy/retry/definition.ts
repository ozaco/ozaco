import type { PolicyDef } from 'server:core'
import { findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, retry, useContext } from 'std:effect'

import type { Retry } from './types'
import { RetryPolicyKey } from './types'
import { getSelf } from './utils'

export const RetryPolicy = Policy.implement({
  name: 'server/policy-retry',
  version: '0.0.0',
  *setup(options?: Retry.Options) {
    const context: Retry.Context = {
      name: options?.name ?? 'policy/retry',
      priority: options?.priority ?? 30,
      attempts: options?.attempts ?? 3,
      delay: options?.delay ?? 0,
      backoff: options?.backoff ?? 1,
      maxDelay: options?.maxDelay ?? 30_000,
      retryStreams: options?.retryStreams ?? false,
      ...(options?.when === undefined ? {} : { when: options.when }),
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<Retry.Options>) {
    return makePolicySetting<Retry.Options>(RetryPolicyKey, { value: options ?? {} })
  }),
  disable: operation(function* () {
    return makePolicySetting<Retry.Options>(RetryPolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    const setting = yield* findPolicySetting<Retry.Options>(dispatchCtx, RetryPolicyKey)
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as Retry.Context
    const retryStreams = override?.retryStreams ?? ctx.retryStreams

    if (dispatchCtx.isStreaming && !retryStreams) {
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
  }),
})
