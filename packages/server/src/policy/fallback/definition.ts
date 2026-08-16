import { definePolicy, PolicyPriority, toWireFailure } from 'server:core'
import type { PolicyDispatch, Reply, Wire } from 'server:core'
import { attempt } from 'std:effect'
import type { Operation } from 'std:effect'
import { isFailure } from 'std:result'

import type { FallbackOptions, FallbackOverride } from './types'

const overrideOf = (override: object | boolean | undefined): FallbackOverride | undefined =>
  typeof override === 'object' ? (override as FallbackOverride) : undefined

const matches = (config: FallbackOptions, failure: Wire.Failure): boolean =>
  config.when ? config.when(failure) : true

function* produce(
  config: FallbackOptions,
  ctx: PolicyDispatch,
  failure: Wire.Failure,
): Operation<Reply> {
  const value = config.handler ? yield* config.handler(ctx, failure) : config.value

  return { kind: 'value', cid: ctx.request.cid, meta: {}, value }
}

/**
 * The fallback layer (`PolicyPriority.fallback`): catches BOTH raised infrastructure failures and
 * business `failure` replies from the layers below. When the `when` predicate matches (default:
 * always) the failure is replaced with a `value` reply — the static `value` or the `handler`'s
 * result; otherwise the original passes through untouched (raised failures re-raise, failure
 * replies return).
 */
export const FallbackPolicy = definePolicy<FallbackOptions, FallbackOptions>({
  name: 'fallback',
  priority: PolicyPriority.fallback,
  *setup(options) {
    return options
  },
  *apply({ ctx, state, override, next }) {
    const config = { ...state, ...overrideOf(override) }
    const outcome = yield* attempt(() => next())

    if (isFailure(outcome)) {
      const failure = toWireFailure(outcome)

      if (!matches(config, failure)) {
        return yield* outcome
      }

      return yield* produce(config, ctx, failure)
    }

    const reply = outcome.value

    if (reply.kind !== 'failure' || !matches(config, reply.failure)) {
      return reply
    }

    return yield* produce(config, ctx, reply.failure)
  },
})
