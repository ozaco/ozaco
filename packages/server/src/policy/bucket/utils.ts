import { asFailure, fail } from 'std:result'

import type { Bucket } from './types'

export const scheduleCleanup = (
  ctx: Bucket.Context,
  args: { key: string; entry: Bucket.Entry; interval?: number },
) => {
  const { key, entry, interval } = args
  entry.timer = setTimeout(() => {
    if (ctx.entries.get(key) === entry) {
      ctx.entries.delete(key)
    }
  }, interval ?? ctx.interval)
}

export const tearDown = (ctx: Bucket.Context) => {
  for (const entry of ctx.entries.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    // resolve (don't reject) with a failure-outcome so any joiner re-throws it in its own coroutine
    entry.resolvers.resolve({
      ok: false,
      failure: asFailure(fail('cancelled', 'bucket policy torn down')),
    })
  }
  ctx.entries.clear()
}
