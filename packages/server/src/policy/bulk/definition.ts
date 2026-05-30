import type { PolicyDef } from 'server:core'
import { CoreErrors, findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, useContext, withResolvers } from 'std:effect'
import { fail } from 'std:result'

import { BulkPolicyKey } from './types'
import type { Bulk } from './types'
import { getSelf, release, tearDown } from './utils'

export const BulkPolicy = Policy.implement({
  name: 'server/policy-bulk',
  version: '0.0.0',
  *setup(options?: Bulk.Options) {
    const context: Bulk.Context = {
      name: options?.name ?? 'policy/bulk',
      priority: options?.priority ?? 20,
      maxConcurrent: options?.maxConcurrent ?? 20,
      maxQueue: options?.maxQueue ?? 0,
      queueTimeout: options?.queueTimeout ?? 0,
      inflight: 0,
      queue: [],
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      tearDown(context)
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<Bulk.Options>) {
    return makePolicySetting<Bulk.Options>(BulkPolicyKey, { value: options ?? {} })
  }),
  disable: operation(function* () {
    return makePolicySetting<Bulk.Options>(BulkPolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    const setting = yield* findPolicySetting<Bulk.Options>(dispatchCtx, BulkPolicyKey)
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as Bulk.Context
    const maxConcurrent = override?.maxConcurrent ?? ctx.maxConcurrent
    const maxQueue = override?.maxQueue ?? ctx.maxQueue
    const queueTimeout = override?.queueTimeout ?? ctx.queueTimeout

    if (ctx.inflight < maxConcurrent) {
      ctx.inflight++
    } else {
      if (ctx.queue.length >= maxQueue) {
        return yield* fail(CoreErrors.BulkQueueFull, `bulk queue full (max ${maxQueue})`)
      }

      const resolvers = withResolvers<void>('policy:bulk')
      const waiter: Bulk.Waiter = { resolvers }

      if (queueTimeout > 0) {
        waiter.timer = setTimeout(() => {
          const idx = ctx.queue.indexOf(waiter)
          if (idx !== -1) {
            ctx.queue.splice(idx, 1)
            waiter.resolvers.reject(
              fail(CoreErrors.BulkQueueTimeout, `bulk queue wait exceeded ${queueTimeout}ms`),
            )
          }
        }, queueTimeout)
      }

      ctx.queue.push(waiter)
      yield* resolvers.operation
    }

    try {
      return yield* next()
    } finally {
      release(ctx)
    }
  }),
})
