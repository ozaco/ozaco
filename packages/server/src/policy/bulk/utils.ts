import { fail } from 'std:result'

import type { Bulk } from './types'

export const release = (ctx: Bulk.Context) => {
  ctx.inflight = Math.max(0, ctx.inflight - 1)
  const next = ctx.queue.shift()
  if (next) {
    if (next.timer) {
      clearTimeout(next.timer)
    }
    ctx.inflight++
    next.resolvers.resolve()
  }
}

export const tearDown = (ctx: Bulk.Context) => {
  for (const waiter of ctx.queue) {
    if (waiter.timer) {
      clearTimeout(waiter.timer)
    }
    waiter.resolvers.reject(fail('cancelled', 'bulk policy torn down'))
  }
  ctx.queue.length = 0
  ctx.inflight = 0
}
