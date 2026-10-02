// oxlint-disable import/exports-last
import { Kv } from 'db:core'
import type { ServerDef } from 'server:core'
import { ServerErrors, statusOf } from 'server:core'
import { dispatchFailure, scopeOf, SENT_BINDING } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, createSemaphore, race, sleep, useContext, withResolvers } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace, TraceSeverity } from 'std:trace'

import { z } from 'zod'

import { ResilienceCauses } from './errors'
import type { ResilienceDef } from './types'

const RETRY_DEFAULT = [ServerErrors.TimeoutUnreached, ServerErrors.Unavailable]

/** The instrumentation scope of every resilience record (`@ozaco/server/resilience`). */
export const RESILIENCE_SCOPE = scopeOf('resilience')

/** A retried attempt (≥ 2) and a fallback's primary path. */
const ATTEMPT_SPAN = 'resilience.attempt'

/** The time a call queued for a bulkhead slot. */
const WAIT_SPAN = 'resilience.bulkhead.wait'

/** A circuit's state change (≤ 20 chars). */
const BREAKER_EVENT = 'breaker'

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

/** The context a later record may link: only a recording span's (an idle / read-only view has
 * none worth pointing at). */
const linkable = (handle: TraceDef.SpanHandle): TraceDef.SpanContext | null =>
  handle.recording ? handle.context : null

// --- timeout ----------------------------------------------------------------------------------

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
      ResilienceCauses.Timeout,
    )
  }

  return winner.value
}

// --- retry ------------------------------------------------------------------------------------

/**
 * Retry the rest of the chain. Attempt 1 runs INLINE — a call that is never retried gets no span
 * of its own; when it fails and a retry follows, its failure is recorded handled (WARN) on the
 * DISPATCH span (`step.span`, whatever plugin span is active). Every later attempt runs in a `resilience.attempt` span
 * (`ozaco.resilience.attempt = n`, `ozaco.resilience.delay_ms` = the backoff before it) that
 * fails with its failure: one that is retried settles as handled (WARN) once the call ends, the
 * last one escapes with the call and settles by its status class.
 */
export function* withRetry(
  retry: ResilienceDef.Retry,
  { call, ctx, span: dispatch, next }: ResilienceDef.Step,
): Operation<unknown> {
  const when = new Set(retry.when ?? RETRY_DEFAULT)
  const retries = (failure: Result.Failure<unknown>, round: number): boolean =>
    round < retry.times && when.has(String(failure.error))

  const first = yield* attempt(next)

  if (!isFailure(first)) {
    return first.value
  }

  if (!retries(first, 0)) {
    return yield* first
  }

  yield* dispatch.recordFailure(first, { handled: true })

  for (let round = 1; ; round += 1) {
    const delayMs = (retry.delayMs ?? 100) * 2 ** (round - 1)

    yield* sleep(delayMs)

    // a returned Failure fails the span (held until it settles); the runtime raises it, the outer
    // `attempt` hands it back as a value
    const outcome = yield* attempt(() =>
      Trace.actions.span(
        ATTEMPT_SPAN,
        {
          scope: RESILIENCE_SCOPE,
          attributes: {
            'ozaco.resilience.attempt': round + 1,
            'ozaco.resilience.delay_ms': delayMs,
          },
          failure: dispatchFailure(call, ctx.meta),
        },
        () => attempt(next),
      ),
    )

    if (!isFailure(outcome)) {
      return outcome.value
    }

    if (!retries(outcome, round)) {
      return yield* outcome
    }
  }
}

// --- fallback ---------------------------------------------------------------------------------

/**
 * A fallback's PRIMARY path, in a `resilience.attempt` span that fails with the primary's failure
 * (its whole chain recorded once — WARN when the fallback answers, by its status class when the
 * call still fails). Resolves the primary's outcome as a Result.
 */
export const primary = ({
  call,
  ctx,
  next,
}: Pick<ResilienceDef.Step, 'call' | 'ctx' | 'next'>): Operation<Result<unknown>> =>
  attempt(() =>
    Trace.actions.span(
      ATTEMPT_SPAN,
      { scope: RESILIENCE_SCOPE, failure: dispatchFailure(call, ctx.meta) },
      () => attempt(next),
    ),
  )

// --- breaker ----------------------------------------------------------------------------------

/** A circuit's state change: a `breaker` event on the DISPATCH span AND its record (WARN when
 * it opens, correlated to that span) — the record under the plugin's own scope
 * (`@ozaco/server/resilience`), not the dispatch's — AND, with a std Logger installed, the same
 * line in the terminal (bound `ozaco.telemetry = 'sent'`: the Logger's `TraceTransport` makes no
 * second record of it). Never fails the dispatch. */
function* transition(
  dispatch: TraceDef.SpanHandle,
  key: string,
  [previous, state]: readonly [ResilienceDef.CircuitState, ResilienceDef.CircuitState],
): Operation<void> {
  const attributes = {
    'ozaco.resilience.breaker.state': state,
    'ozaco.resilience.breaker.state.previous': previous,
  }

  const body = `${key}: circuit ${previous} → ${state}`
  const opened = state === 'open'

  dispatch.addEvent(BREAKER_EVENT, attributes)
  yield* Trace.actions.emitLog({
    body,
    severityNumber: opened ? TraceSeverity.warn : TraceSeverity.info,
    eventName: BREAKER_EVENT,
    attributes,
    scope: RESILIENCE_SCOPE,
    // no dispatch span (a no-op handle): the record goes where the active span is
    context: dispatch.valid ? dispatch.context : undefined,
  })

  if ((yield* Logger.context.get()) !== undefined) {
    yield* attempt(() =>
      Logger.actions.child({ ...SENT_BINDING, logger: RESILIENCE_SCOPE.name }, () =>
        opened ? Logger.actions.warn(body, attributes) : Logger.actions.info(body, attributes),
      ),
    )
  }
}

/**
 * A circuit breaker per action: `failures` consecutive server-side failures (`statusOf >= 500` —
 * a client failure proves nothing about the dependency and is not counted) open it; while open,
 * calls fail fast (`server.unavailable`) and LINK the span of the call that tripped it
 * (`breaker.trip`); after `halfOpenMs` one trial call probes it (success closes it, a counted
 * failure re-opens it, a halted / uncounted trial frees the slot for the next probe). Every
 * change of state is an `breaker` event.
 */
export function* withBreaker(
  breaker: ResilienceDef.Breaker,
  { state, call, ctx, span: dispatch, next }: ResilienceDef.Step,
): Operation<unknown> {
  const key = keyOf(call)
  const circuit: ResilienceDef.BreakerState = state.breakers.get(key) ?? {
    failures: 0,
    openedAt: null,
    trial: false,
    trippedBy: null,
  }

  state.breakers.set(key, circuit)

  const halfOpenMs = breaker.halfOpenMs ?? 10_000
  const probing = circuit.openedAt !== null

  if (circuit.openedAt !== null) {
    if (Date.now() - circuit.openedAt < halfOpenMs || circuit.trial) {
      if (circuit.trippedBy) {
        dispatch.addLink(circuit.trippedBy, { 'ozaco.link.reason': 'breaker.trip' })
      }

      return yield* fail(ServerErrors.Unavailable, `${key}: circuit open`, ResilienceCauses.Breaker)
    }

    circuit.trial = true
  }

  let settled = false

  try {
    if (probing) {
      yield* transition(dispatch, key, ['open', 'half_open'])
    }

    const outcome = yield* attempt(next)

    settled = true

    if (!isFailure(outcome)) {
      const previous = probing ? 'half_open' : circuit.openedAt === null ? null : 'open'

      circuit.failures = 0
      circuit.openedAt = null
      circuit.trial = false
      circuit.trippedBy = null

      if (previous) {
        yield* transition(dispatch, key, [previous, 'closed'])
      }

      return outcome.value
    }

    if (statusOf(outcome, ctx.meta) < 500) {
      // a client failure: not counted — a trial it answered lets the next caller probe again
      if (probing) {
        circuit.trial = false
      }

      return yield* outcome
    }

    circuit.failures += 1

    const previous = probing ? 'half_open' : circuit.openedAt === null ? 'closed' : null

    if (previous && (probing || circuit.failures >= breaker.failures)) {
      circuit.openedAt = Date.now()
      circuit.trippedBy = linkable(dispatch)
      yield* transition(dispatch, key, [previous, 'open'])
    }

    circuit.trial = false

    return yield* outcome
  } finally {
    // a trial halted mid-flight never settled: free the slot for the next probe
    if (probing && !settled) {
      circuit.trial = false
    }
  }
}

// --- bulkhead ---------------------------------------------------------------------------------

/**
 * At most `max` calls of an action at once (a FIFO semaphore — nothing polls), `queue` more
 * waiting for a slot, the rest refused (`server.unavailable`). A call that has to queue spends the
 * wait in a `resilience.bulkhead.wait` span; a halted waiter leaves the queue.
 */
export function* withBulkhead(
  bulkhead: ResilienceDef.Bulkhead,
  { state, call, next }: ResilienceDef.Step,
): Operation<unknown> {
  const key = keyOf(call)
  const slot = state.bulkheads.get(key) ?? { semaphore: createSemaphore(bulkhead.max), queued: 0 }

  state.bulkheads.set(key, slot)

  const { semaphore } = slot

  // a free slot and nobody ahead: `run` takes it without parking
  if (semaphore.available() > 0 && slot.queued === 0) {
    return yield* semaphore.run(next)
  }

  if (slot.queued >= (bulkhead.queue ?? 0)) {
    return yield* fail(ServerErrors.Unavailable, `${key}: bulkhead full`, ResilienceCauses.Bulkhead)
  }

  // queued from HERE (synchronously — opening the span yields) until a slot is granted
  slot.queued += 1

  let queued = true
  const leave = (): void => {
    if (queued) {
      queued = false
      slot.queued -= 1
    }
  }
  let wait: TraceDef.LiveSpan | null = null

  try {
    const waiting = yield* Trace.actions.startSpan(WAIT_SPAN, { scope: RESILIENCE_SCOPE })

    wait = waiting

    return yield* semaphore.run(function* () {
      leave()
      yield* waiting.end()

      return yield* next()
    })
  } finally {
    // halted while queued: out of the queue, the wait cut short (a no-op once it was granted)
    leave()

    if (wait) {
      yield* wait.end({ cancelled: true })
    }
  }
}

// --- singleflight -----------------------------------------------------------------------------

/**
 * Concurrent calls of an action with the same input share ONE computation: the first is the
 * leader (`ozaco.resilience.singleflight = 'leader'`), the rest follow it (`'follower'`, a LINK to
 * the leader's span — `singleflight`) and get its outcome — a failure then fails each follower's
 * own trace (recorded there once). A halted leader releases its followers: they go round again
 * (one of them leads).
 */
export function* withSingleflight({
  state,
  call,
  span: dispatch,
  next,
}: ResilienceDef.Step): Operation<unknown> {
  const key = `${keyOf(call)}:${hash(call.input)}`

  for (let running = state.inflight.get(key); running; running = state.inflight.get(key)) {
    dispatch.setAttribute('ozaco.resilience.singleflight', 'follower')

    if (running.leader) {
      dispatch.addLink(running.leader, { 'ozaco.link.reason': 'singleflight' })
    }

    const shared = yield* running.outcome

    if (shared !== null) {
      return isFailure(shared) ? yield* shared : shared.value
    }
  }

  dispatch.setAttribute('ozaco.resilience.singleflight', 'leader')

  const settled = withResolvers<Result<unknown> | null>('singleflight')
  const flight: ResilienceDef.Flight = { outcome: settled.operation, leader: linkable(dispatch) }

  state.inflight.set(key, flight)

  let outcome: Result<unknown> | null = null

  try {
    outcome = yield* attempt(next)
  } finally {
    if (state.inflight.get(key) === flight) {
      state.inflight.delete(key)
    }

    // `null` ⇒ halted before it settled: the followers go round again
    settled.resolve(outcome)
  }

  return isFailure(outcome) ? yield* outcome : outcome.value
}

// --- rate limit -------------------------------------------------------------------------------

/**
 * A fixed-window rate limit per action and subject (`global`, the caller's ip, its principal):
 * cluster-wide through the installed `Kv` (`incr`), in-memory otherwise. The span gets
 * `ozaco.resilience.rate_limit.remaining`; past the limit the call fails `server.rate-limited`.
 */
export function* withRateLimit(
  limit: ResilienceDef.RateLimit,
  { state, call, ctx, span: dispatch, next }: ResilienceDef.Step,
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

  dispatch.setAttribute('ozaco.resilience.rate_limit.remaining', Math.max(0, limit.limit - count))

  if (count > limit.limit) {
    return yield* fail(
      ServerErrors.RateLimited,
      `${keyOf(call)}: ${limit.limit} calls per ${limit.windowMs}ms exceeded`,
      ResilienceCauses.RateLimit,
    )
  }

  return yield* next()
}
