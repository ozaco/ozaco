import type { Operation } from 'std:effect'
import { attempt, useScope } from 'std:effect'
import { isFailure } from 'std:result'

import { ActiveSpan } from '../definition'
import { handleIn } from '../internal/active'
import { finish } from '../internal/settle'
import { idleOf, liveOf, open } from '../internal/span'
import type { Helpers } from '../types/helpers'
import type { TraceDef } from '../types/trace'

/**
 * Start a span whose end the caller decides — a streamed body, a lane: `live.run(body)` runs code
 * with it active, `live.end({ failure?, cancelled?, time? })` ends it (idempotent; a `failure` goes
 * through hold-until-settled like one escaping `span()`). Tracing off ⇒ an idle span: `run` just
 * runs the body, `end` does nothing.
 */
export function* startSpan(
  name: string,
  options: TraceDef.SpanOptions = {},
): Operation<TraceDef.LiveSpan> {
  const scope = yield* useScope()
  const rec = open(scope, name, options)

  return rec ? liveOf(rec) : idleOf(handleIn(scope))
}

/**
 * Run `body` in a span. Tracing off / suppressed (or `requireParent` without a recording parent):
 * the body runs with the current handle and `ActiveSpan` is not touched, no ids are minted.
 * Otherwise the span is active for the body (every fork of it shares the one recorder) and ends
 * with its outcome: a failure raised — or RETURNED — by the body fails it (the failure is held
 * until it settles, see `settle`), a halt marks it `ozaco.cancelled`. The body's own value or
 * failure passes through unchanged.
 */
export function span<T>(name: string, body: Helpers.Body<T>): Operation<T>
export function span<T>(
  name: string,
  options: TraceDef.SpanOptions,
  body: Helpers.Body<T>,
): Operation<T>
export function* span<T>(
  name: string,
  optionsOrBody: TraceDef.SpanOptions | Helpers.Body<T>,
  maybeBody?: Helpers.Body<T>,
): Operation<T> {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody
  // the overloads guarantee a body in one of the two places
  const body = (typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody) as Helpers.Body<T>

  const scope = yield* useScope()
  const rec = open(scope, name, options)

  if (!rec) {
    return yield* body(handleIn(scope))
  }

  let ended = false

  try {
    const outcome = yield* attempt(() => ActiveSpan.with(rec, () => body(rec.handle)))
    ended = true

    if (isFailure(outcome)) {
      yield* finish(rec, { t: 'failed', failure: outcome })
      return yield* outcome
    }

    const value = outcome.value
    yield* finish(rec, isFailure(value) ? { t: 'failed', failure: value } : { t: 'ok' })

    return value
  } finally {
    if (!ended) {
      yield* finish(rec, { t: 'halted' })
    }
  }
}
