import { fail, isFailure } from 'std:result'

import { attempt } from '../base/attempt'
import { EffectCauses, EffectErrors } from '../errors'
import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

const describe = (reason: unknown): string => {
  if (reason === undefined) {
    return ''
  }

  if (isFailure(reason)) {
    return String(reason.message || reason.error)
  }

  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * A circuit breaker for any operation. CLOSED runs `op` and counts consecutive failures (only the
 * ones `when` accepts); `failures` in a row trip it OPEN, where `run` fails fast with
 * `EffectErrors.BreakerOpen` without calling `op`. After `halfOpenMs` it turns HALF-OPEN: ONE
 * trial call goes through (concurrent callers still fail fast) — success closes the circuit, a
 * failure re-opens it for another `halfOpenMs`, a halted trial leaves it half-open for the next
 * caller. `trip(reason)` opens it by hand; a `terminal` trip never half-opens — only `reset()`
 * closes it again.
 */
export const createBreaker = (options: Utils.BreakerOptions): Utils.Breaker => {
  const threshold = Math.max(1, Math.floor(options.failures))
  const halfOpenMs = options.halfOpenMs ?? 10_000
  const now = options.now ?? Date.now
  const label = options.name ? `${options.name}: circuit open` : 'circuit open'

  let failures = 0
  let openedAt: number | null = null
  let terminal = false
  let trial = false
  let reason: unknown = undefined

  const open = (cause: unknown, final: boolean) => {
    openedAt = now()
    terminal = final
    reason = cause
    trial = false
  }

  const state = (): Utils.BreakerState => {
    if (openedAt === null) {
      return 'closed'
    }

    if (terminal || (!trial && now() - openedAt < halfOpenMs)) {
      return 'open'
    }

    return 'half-open'
  }

  function* run<T>(op: () => Operation<T>): Operation<T> {
    const current = state()

    if (current === 'open' || (current === 'half-open' && trial)) {
      const detail = describe(reason)
      return yield* fail(
        EffectErrors.BreakerOpen,
        detail ? `${label} (${detail})` : label,
        EffectCauses.Breaker,
      )
    }

    const probing = current === 'half-open'
    if (probing) {
      trial = true
    }

    let settled = false
    try {
      const outcome = yield* attempt(op)
      settled = true

      // a terminal trip that landed while this call was in flight wins over its outcome
      if (terminal) {
        return isFailure(outcome) ? yield* outcome : outcome.value
      }

      if (!isFailure(outcome)) {
        failures = 0
        openedAt = null
        trial = false
        reason = undefined
        return outcome.value
      }

      if (options.when?.(outcome) ?? true) {
        failures += 1

        if (probing || failures >= threshold) {
          open(outcome, false)
        }
      } else if (probing) {
        // an ignored failure proves nothing either way — let the next caller probe again
        trial = false
      }

      return yield* outcome
    } finally {
      // a trial halted mid-flight never settled — free the slot for the next probe
      if (probing && !settled && trial) {
        trial = false
      }
    }
  }

  return {
    run,
    state,

    trip(cause?: unknown, tripOptions?: { terminal?: boolean | undefined }) {
      open(cause, tripOptions?.terminal ?? false)
    },

    reset() {
      failures = 0
      openedAt = null
      terminal = false
      trial = false
      reason = undefined
    },

    get reason() {
      return reason
    },

    get failures() {
      return failures
    },
  }
}
