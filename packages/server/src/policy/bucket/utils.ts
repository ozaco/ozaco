import type { PolicyDef } from 'server:core'
import { fail } from 'std:result'

import { BucketPolicy } from './definition'
import type { Bucket } from './types'

export const getSelf = (): PolicyDef => BucketPolicy

export const scheduleCleanup = (ctx: Bucket.Context, key: string, entry: Bucket.Entry) => {
  entry.timer = setTimeout(() => {
    if (ctx.entries.get(key) === entry) {
      ctx.entries.delete(key)
    }
  }, ctx.interval)
}

export const tearDown = (ctx: Bucket.Context) => {
  for (const entry of ctx.entries.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.resolvers.reject(fail('cancelled', 'bucket policy torn down'))
  }
  ctx.entries.clear()
}
