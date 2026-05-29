import type { PolicyDef } from 'server:core'
import { Policy } from 'server:core'
import { ensure, operation, useContext, useScope, withResolvers } from 'std:effect'
import { asFailure, isSuccess } from 'std:result'

import type { Bucket } from './types'
import { getSelf, scheduleCleanup, tearDown } from './utils'

export const BucketPolicy = Policy.implement({
  name: 'server/policy-bucket',
  version: '0.0.0',
  *setup(options: Bucket.Options) {
    const name = options.name ?? 'policy/bucket'
    const priority = options.priority ?? 10
    const interval = options.interval ?? 20
    const max = options.max

    const scope = yield* useScope()

    const context: Bucket.Context = {
      name,
      priority,
      interval,
      max,
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
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    if (dispatchCtx.isStreaming) {
      return yield* next()
    }

    const ctx = (yield* useContext(getSelf())) as Bucket.Context
    const key = dispatchCtx.key

    const existing = ctx.entries.get(key)
    if (existing && existing.count < ctx.max) {
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
        scheduleCleanup(ctx, key, entry)
      },
      error => {
        resolvers.reject(asFailure(error))
        scheduleCleanup(ctx, key, entry)
      },
    )

    return (yield* resolvers.operation) as T
  }),
})
