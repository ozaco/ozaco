import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import { spawn, withResolvers } from 'std:effect'
import { asFailure, fail } from 'std:result'

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

    const winner = withResolvers<unknown>('policy:timeout')
    const timer = setTimeout(() => winner.resolve(TIMEOUT_SENTINEL), timeoutMs)

    const task = yield* spawn(function* () {
      try {
        const value = yield* next()
        winner.resolve(value)
      } catch (error) {
        winner.reject(asFailure(error))
      } finally {
        clearTimeout(timer)
      }
    })

    const result = yield* winner.operation

    if (result === TIMEOUT_SENTINEL) {
      yield* task.halt()
      return yield* fail(
        CoreErrors.Timeout,
        `dispatch exceeded ${timeoutMs}ms for ${dispatch.serviceName}.${dispatch.actionKey}`,
      )
    }

    return result
  },
})
