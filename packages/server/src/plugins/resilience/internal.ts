// oxlint-disable import/exports-last
import { Kv } from 'db:core'
import type { ServerDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, race, sleep, useContext, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { ResilienceDef } from './types'

const RETRY_DEFAULT = [ServerErrors.TimeoutUnreached, ServerErrors.Unavailable]

export const options = {
  timeoutMs: z.number().positive(),

  retry: z.object({
    times: z.number().int().min(0),
    when: z.array(z.string()).optional(),
    delayMs: z.number().min(0).optional(),
  }),

  breaker: z.object({
    failures: z.number().int().min(1),
    halfOpenMs: z.number().min(0).optional(),
  }),
  bulkhead: z.object({ max: z.number().int().min(1), queue: z.number().int().min(0).optional() }),
  singleflight: z.boolean(),

  rateLimit: z.object({
    limit: z.number().int().min(1),
    windowMs: z.number().positive(),
    key: z.enum(['global', 'ip', 'auth']).optional(),
  }),
  fallback: z.custom<ResilienceDef.Fallback>(value => typeof value === 'function', 'a function'),
}

export const keyOf = (call: ServerDef.Call): string => `${call.service}.${call.action}`

export const hash = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'undefined'
  let code = 0

  for (let index = 0; index < text.length; index += 1) {
    code = (code * 31 + (text.codePointAt(index) ?? 0)) | 0
  }

  return (code >>> 0).toString(36)
}

export function* withTimeout(
  ms: number,
  call: ServerDef.Call,
  next: ResilienceDef.Next,
): Operation<unknown> {
  const winner = yield* race([
    (function* () {
      return { value: yield* next() }
    })(),
    (function* () {
      yield* sleep(ms)
      return { timeout: true as const }
    })(),
  ])

  if ('timeout' in winner) {
    return yield* fail(
      ServerErrors.TimeoutPending,
      `${keyOf(call)} exceeded ${ms}ms`,
      'resilience:timeout',
    )
  }

  return winner.value
}

export function* withRetry(
  retry: ResilienceDef.Retry,
  next: ResilienceDef.Next,
): Operation<unknown> {
  const when = new Set(retry.when ?? RETRY_DEFAULT)

  for (let round = 0; ; round += 1) {
    const outcome = yield* attempt(next)

    if (!isFailure(outcome)) {
      return outcome.value
    }

    if (round >= retry.times || !when.has(String(outcome.error))) {
      return yield* outcome
    }

    yield* sleep((retry.delayMs ?? 100) * 2 ** round)
  }
}

export function* withBreaker(
  breaker: ResilienceDef.Breaker,
  { state, call, next }: ResilienceDef.Step,
): Operation<unknown> {
  const key = keyOf(call)
  const circuit = state.breakers.get(key) ?? { failures: 0, openedAt: null, trial: false }
  state.breakers.set(key, circuit)
  const halfOpenMs = breaker.halfOpenMs ?? 10_000

  if (circuit.openedAt !== null) {
    if (Date.now() - circuit.openedAt < halfOpenMs || circuit.trial) {
      return yield* fail(ServerErrors.Unavailable, `${key}: circuit open`, 'resilience:breaker')
    }

    circuit.trial = true
  }

  const outcome = yield* attempt(next)

  if (isFailure(outcome)) {
    circuit.failures += 1
    circuit.trial = false

    if (circuit.failures >= breaker.failures) {
      circuit.openedAt = Date.now()
    }

    return yield* outcome
  }

  circuit.failures = 0
  circuit.openedAt = null
  circuit.trial = false

  return outcome.value
}

export function* withBulkhead(
  bulkhead: ResilienceDef.Bulkhead,
  { state, call, next }: ResilienceDef.Step,
): Operation<unknown> {
  const key = keyOf(call)
  const slot = state.bulkheads.get(key) ?? { active: 0, waiting: 0 }
  state.bulkheads.set(key, slot)

  if (slot.active >= bulkhead.max) {
    if (slot.waiting >= (bulkhead.queue ?? 0)) {
      return yield* fail(ServerErrors.Unavailable, `${key}: bulkhead full`, 'resilience:bulkhead')
    }

    slot.waiting += 1

    while (slot.active >= bulkhead.max) {
      yield* sleep(5)
    }

    slot.waiting -= 1
  }

  slot.active += 1

  try {
    return yield* next()
  } finally {
    slot.active -= 1
  }
}

export function* withSingleflight({ state, call, next }: ResilienceDef.Step): Operation<unknown> {
  const key = `${keyOf(call)}:${hash(call.input)}`
  const running = state.inflight.get(key)

  if (running) {
    const shared = yield* running

    if (isFailure(shared)) {
      return yield* shared
    }

    return shared.value
  }

  const settled = withResolvers<Result<unknown>>('singleflight')
  state.inflight.set(key, settled.operation)
  const outcome = yield* attempt(next)
  state.inflight.delete(key)
  settled.resolve(outcome as Result<unknown>)

  if (isFailure(outcome)) {
    return yield* outcome
  }

  return outcome.value
}

export function* withRateLimit(
  limit: ResilienceDef.RateLimit,
  { state, call, ctx, next }: ResilienceDef.Step,
): Operation<unknown> {
  const subject =
    limit.key === 'ip'
      ? (call.headers['x-forwarded-for'] ?? call.headers['x-real-ip'] ?? 'unknown')
      : limit.key === 'auth'
        ? String((ctx.auth as AnyType)?.id ?? (ctx.auth as AnyType)?.sub ?? 'anonymous')
        : 'global'
  const window = Math.floor(Date.now() / limit.windowMs)
  const key = `rl:${keyOf(call)}:${subject}:${window}`
  let count: number

  if (isFailure(yield* attempt(() => useContext(Kv)))) {
    const local = state.counters.get(key) ?? { count: 0, window }
    local.count += 1
    state.counters.set(key, local)
    count = local.count
  } else {
    // cluster-wide when a Kv store is installed
    count = yield* Kv.actions.incr(key, 1, { ttlMs: limit.windowMs })
  }

  if (count > limit.limit) {
    return yield* fail(
      ServerErrors.RateLimited,
      `${keyOf(call)}: ${limit.limit} calls per ${limit.windowMs}ms exceeded`,
      'resilience:rate-limit',
    )
  }

  return yield* next()
}
