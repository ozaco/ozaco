import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import { race, sleep } from 'std:effect'
import { fail } from 'std:result'

import type { Timeout } from './types'
import { TimeoutPolicyKey } from './types'

const TIMEOUT_SENTINEL = Symbol('timeout-sentinel')

export const TimeoutPolicy = definePolicy<Timeout.Options, Timeout.Context>({
  key: TimeoutPolicyKey,
  name: 'server/policy-timeout',
  contextName: 'policy/timeout',
  // innermost by default (see PolicyPriority): the timeout bounds only the actual dispatch and
  // surfaces as a normal CoreErrors.Timeout failure that outer policies observe through catch.
  priority: PolicyPriority.Timeout,
  *setup(options, base) {
    return {
      ...base,
      timeoutMs: options?.timeoutMs ?? 30_000,
      timeoutStreams: options?.timeoutStreams ?? false,
    }
  },
  *apply({ dispatch, ctx, override, next }) {
    const timeoutMs = override?.timeoutMs ?? ctx.timeoutMs
    const timeoutStreams = override?.timeoutStreams ?? ctx.timeoutStreams

    if (dispatch.isStreaming && !timeoutStreams) {
      return yield* next()
    }

    // race the dispatch against a timer; the loser is halted automatically (on timeout this cancels
    // the in-flight dispatch, on success it cancels the timer) — no manual winner/halt bookkeeping
    const result = yield* race([
      next(),
      (function* () {
        yield* sleep(timeoutMs)
        return TIMEOUT_SENTINEL
      })(),
    ])

    if (result === TIMEOUT_SENTINEL) {
      return yield* fail(
        CoreErrors.Timeout,
        `dispatch exceeded ${timeoutMs}ms for ${dispatch.serviceName}.${dispatch.actionKey}`,
      )
    }

    return result
  },
})
