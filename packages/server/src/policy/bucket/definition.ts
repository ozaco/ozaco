import type { PolicyDef } from 'server:core'
import { findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, useContext, useScope, withResolvers } from 'std:effect'
import { asFailure, isSuccess } from 'std:result'

import { BucketPolicyKey } from './types'
import type { Bucket } from './types'
import { getSelf, scheduleCleanup, tearDown } from './utils'

export const BucketPolicy = Policy.implement({
  name: 'server/policy-bucket',
  version: '0.0.0',
  *setup(options?: Bucket.Options) {
    const scope = yield* useScope()

    const context: Bucket.Context = {
      name: options?.name ?? 'policy/bucket',
      priority: options?.priority ?? 10,
      interval: options?.interval ?? 20,
      max: options?.max ?? 100,
      entries: new Map(),
      scope,
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      tearDown(context)
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<Bucket.Options>) {
    return makePolicySetting<Bucket.Options>(BucketPolicyKey, { value: options ?? {} })
  }),
  disable: operation(function* () {
    return makePolicySetting<Bucket.Options>(BucketPolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    if (dispatchCtx.isStreaming) {
      return yield* next()
    }

    const setting = yield* findPolicySetting<Bucket.Options>(dispatchCtx, BucketPolicyKey)
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as Bucket.Context
    const max = override?.max ?? ctx.max
    const key = dispatchCtx.key

    const existing = ctx.entries.get(key)
    if (existing && existing.count < max) {
      existing.count++
      return (yield* existing.resolvers.operation) as T
    }

    const resolvers = withResolvers<unknown>('policy:bucket')
    const entry: Bucket.Entry = { count: 1, resolvers }
    ctx.entries.set(key, entry)

    ctx.scope.run(next).then(
      // oxlint-disable-next-line promise/always-return
      result => {
        if (isSuccess(result)) {
          resolvers.resolve(result.value)
        } else {
          resolvers.reject(result)
        }
        scheduleCleanup(ctx, {
          key,
          entry,
          ...(override?.interval === undefined ? {} : { interval: override.interval }),
        })
      },
      error => {
        resolvers.reject(asFailure(error))
        scheduleCleanup(ctx, {
          key,
          entry,
          ...(override?.interval === undefined ? {} : { interval: override.interval }),
        })
      },
    )

    return (yield* resolvers.operation) as T
  }),
})
