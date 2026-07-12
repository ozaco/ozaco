import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import { ensure, withResolvers } from 'std:effect'
import { fail } from 'std:result'

import type { Bulk } from './types'
import { BulkPolicyKey } from './types'
import { release, tearDown } from './utils'

export const BulkPolicy = definePolicy<Bulk.Options, Bulk.Context>({
  key: BulkPolicyKey,
  name: 'server/policy-bulk',
  contextName: 'policy/bulk',
  priority: PolicyPriority.Bulk,
  *setup(options, base) {
    return {
      ...base,
      maxConcurrent: options?.maxConcurrent ?? 20,
      maxQueue: options?.maxQueue ?? 0,
      queueTimeout: options?.queueTimeout ?? 0,
      inflight: 0,
      queue: [],
    }
  },
  teardown: tearDown,
  *apply({ ctx, override, next }) {
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
      // if the caller is halted while parked here, dequeue the waiter (and clear its timer) so a
      // freed slot is never handed to a dead waiter whose `finally { release }` will never run
      yield* ensure(function* () {
        waiter.cancelled = true
        const idx = ctx.queue.indexOf(waiter)
        if (idx !== -1) {
          ctx.queue.splice(idx, 1)
        }
        if (waiter.timer) {
          clearTimeout(waiter.timer)
        }
      })
      yield* resolvers.operation
    }

    try {
      return yield* next()
    } finally {
      release(ctx)
    }
  },
})
