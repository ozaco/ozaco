import type { PolicyDef } from 'server:core'
import { CoreErrors, findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, spawn, useContext, withResolvers } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { TimeoutPolicyKey } from './types'
import type { Timeout } from './types'
import { getSelf } from './utils'

const TIMEOUT_SENTINEL = Symbol('timeout-sentinel')

export const TimeoutPolicy = Policy.implement({
  name: 'server/policy-timeout',
  version: '0.0.0',
  *setup(options?: Timeout.Options) {
    const context: Timeout.Context = {
      name: options?.name ?? 'policy/timeout',
      // innermost by default (highest priority number): the timeout bounds only the actual
      // dispatch and surfaces as a normal CoreErrors.Timeout failure that outer policies
      // (circuit-breaker, metrics, retry, fallback) observe through their catch blocks. If the
      // timeout sat outside them it would halt their generators, and a halt does NOT run catch
      // or finally (only scope `ensure` cleanup runs) — so they could neither record nor recover.
      priority: options?.priority ?? 60,
      timeoutMs: options?.timeoutMs ?? 30_000,
      timeoutStreams: options?.timeoutStreams ?? false,
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<Timeout.Options>) {
    return makePolicySetting<Timeout.Options>(TimeoutPolicyKey, { value: options ?? {} })
  }),
  disable: operation(function* () {
    return makePolicySetting<Timeout.Options>(TimeoutPolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    const setting = yield* findPolicySetting<Timeout.Options>(dispatchCtx, TimeoutPolicyKey)
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as Timeout.Context
    const timeoutMs = override?.timeoutMs ?? ctx.timeoutMs
    const timeoutStreams = override?.timeoutStreams ?? ctx.timeoutStreams

    if (dispatchCtx.isStreaming && !timeoutStreams) {
      return yield* next()
    }

    const winner = withResolvers<T | typeof TIMEOUT_SENTINEL>('policy:timeout')
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
        `dispatch exceeded ${timeoutMs}ms for ${dispatchCtx.serviceName}.${dispatchCtx.actionKey}`,
      )
    }

    return result
  }),
})
