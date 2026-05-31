import type { Cache } from './types'

export const evictOldest = (ctx: Cache.Context) => {
  const oldestKey = ctx.entries.keys().next().value
  if (oldestKey === undefined) {
    return
  }
  const entry = ctx.entries.get(oldestKey)
  if (entry) {
    clearTimeout(entry.timer)
  }
  ctx.entries.delete(oldestKey)
}

export const tearDown = (ctx: Cache.Context) => {
  for (const entry of ctx.entries.values()) {
    clearTimeout(entry.timer)
  }
  ctx.entries.clear()
}
