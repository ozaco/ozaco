import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import type {
  BreakerSlot,
  CircuitBreakerOptions,
  CircuitBreakerOverride,
  CircuitBreakerState,
} from './types'

const DEFAULT_THRESHOLD = 5
const DEFAULT_RESET_TIMEOUT_MS = 30_000
const DEFAULT_HALF_OPEN_MAX = 1

const overrideOf = (override: object | boolean | undefined): CircuitBreakerOverride | undefined =>
  typeof override === 'object' ? (override as CircuitBreakerOverride) : undefined

/** Action identity: the first two `\0` segments of the dispatch key (`service\0action`). */
const breakerKeyOf = (key: string): string => {
  const separator = key.indexOf('\0', key.indexOf('\0') + 1)

  return separator === -1 ? key : key.slice(0, separator)
}

/**
 * The circuit-breaker layer (`PolicyPriority.circuitBreaker`), keyed per action. Counted as
 * failure: every raised failure plus `failure` replies with status >= 500 — business 4xx never
 * trips it. `threshold` consecutive counted failures open the circuit; while open every dispatch
 * raises `CoreErrors.Unavailable` immediately. After `resetTimeoutMs` the breaker goes half-open
 * and admits `halfOpenMax` probes — a successful probe closes and resets it, a failed one re-opens
 * it.
 */
export const CircuitBreakerPolicy = definePolicy<CircuitBreakerOptions, CircuitBreakerState>({
  name: 'circuit-breaker',
  priority: PolicyPriority.circuitBreaker,
  *setup(options) {
    return {
      breakers: new Map<string, BreakerSlot>(),
      threshold: options.threshold ?? DEFAULT_THRESHOLD,
      resetTimeoutMs: options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS,
      halfOpenMax: options.halfOpenMax ?? DEFAULT_HALF_OPEN_MAX,
    }
  },
  *apply({ ctx, state, override, next }) {
    const tuned = overrideOf(override)
    const threshold = tuned?.threshold ?? state.threshold
    const resetTimeoutMs = tuned?.resetTimeoutMs ?? state.resetTimeoutMs
    const halfOpenMax = tuned?.halfOpenMax ?? state.halfOpenMax
    const key = breakerKeyOf(ctx.key)
    const slot = state.breakers.get(key) ?? { phase: 'closed', failures: 0, openedAt: 0, probes: 0 }

    state.breakers.set(key, slot)

    const reject = () =>
      fail(
        CoreErrors.Unavailable,
        `circuit open for ${ctx.request.service}.${ctx.request.action}`,
        'policy:circuit-breaker',
      )

    if (slot.phase === 'open') {
      if (Date.now() - slot.openedAt < resetTimeoutMs) {
        return yield* reject()
      }

      slot.phase = 'half-open'
      slot.probes = 0
    }

    if (slot.phase === 'half-open') {
      if (slot.probes >= halfOpenMax) {
        return yield* reject()
      }

      slot.probes += 1
    }

    const outcome = yield* attempt(() => next())
    const counted = isFailure(outcome)
      ? true
      : outcome.value.kind === 'failure' && outcome.value.status >= 500

    if (!counted) {
      slot.phase = 'closed'
      slot.failures = 0
      slot.probes = 0
    } else if (slot.phase === 'half-open') {
      slot.phase = 'open'
      slot.openedAt = Date.now()
      slot.probes = 0
    } else {
      slot.failures += 1

      if (slot.failures >= threshold) {
        slot.phase = 'open'
        slot.openedAt = Date.now()
      }
    }

    if (isFailure(outcome)) {
      return yield* outcome
    }

    return outcome.value
  },
})
