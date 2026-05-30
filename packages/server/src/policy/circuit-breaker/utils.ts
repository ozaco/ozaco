import type { PolicyDef } from 'server:core'

import { CircuitBreakerPolicy } from './definition'
import type { CircuitBreaker } from './types'

export const getSelf = (): PolicyDef => CircuitBreakerPolicy

export interface EffectiveConfig {
  threshold: number
  resetTimeout: number
  halfOpenMax: number
}

export const resolveConfig = (
  ctx: CircuitBreaker.Context,
  override: Partial<CircuitBreaker.Options> | undefined,
): EffectiveConfig => ({
  threshold: override?.threshold ?? ctx.threshold,
  resetTimeout: override?.resetTimeout ?? ctx.resetTimeout,
  halfOpenMax: override?.halfOpenMax ?? ctx.halfOpenMax,
})

export const getOrCreate = (ctx: CircuitBreaker.Context, key: string): CircuitBreaker.Entry => {
  let entry = ctx.entries.get(key)
  if (!entry) {
    entry = { state: 'closed', failures: 0, halfOpenInflight: 0, openedAt: 0 }
    ctx.entries.set(key, entry)
  }
  return entry
}

export const tryAdmit = (cfg: EffectiveConfig, entry: CircuitBreaker.Entry): boolean => {
  if (entry.state === 'closed') {
    return true
  }

  if (entry.state === 'open') {
    if (Date.now() - entry.openedAt < cfg.resetTimeout) {
      return false
    }
    entry.state = 'half-open'
    entry.halfOpenInflight = 0
  }

  if (entry.halfOpenInflight >= cfg.halfOpenMax) {
    return false
  }
  entry.halfOpenInflight++
  return true
}

export const onSuccess = (entry: CircuitBreaker.Entry) => {
  if (entry.state === 'open') {
    // a concurrent probe already re-opened the circuit — a late success must not re-close it,
    // only release the half-open slot this probe held
    entry.halfOpenInflight = Math.max(0, entry.halfOpenInflight - 1)
    return
  }
  if (entry.state === 'half-open') {
    entry.halfOpenInflight = Math.max(0, entry.halfOpenInflight - 1)
  }
  entry.state = 'closed'
  entry.failures = 0
}

export const onFailure = (cfg: EffectiveConfig, entry: CircuitBreaker.Entry) => {
  if (entry.state === 'open') {
    // already open (e.g. re-opened by a concurrent probe) — releasing this probe's slot is
    // idempotent and must not double-count against the threshold
    entry.halfOpenInflight = Math.max(0, entry.halfOpenInflight - 1)
    return
  }
  if (entry.state === 'half-open') {
    entry.halfOpenInflight = Math.max(0, entry.halfOpenInflight - 1)
    entry.state = 'open'
    entry.openedAt = Date.now()
    return
  }
  entry.failures++
  if (entry.failures >= cfg.threshold) {
    entry.state = 'open'
    entry.openedAt = Date.now()
  }
}
