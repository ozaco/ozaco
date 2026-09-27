import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'
import type { Result } from 'std:result'

import { activeOf } from '../internal/context'
import { isRecordedIn, markRecordedIn } from '../internal/registry'
import { recordChecked, settleIn } from '../internal/settle'
import type { TraceDef } from '../types/trace'

/**
 * Record `failure` on the ACTIVE span now — once per (failure, trace): an `exception` span event
 * when the span records, and one exception log record even when it does not (or when there is no
 * span at all). Severity: `options.severity`, else 13 (WARN) when `handled`, else 17 (ERROR); event
 * name: `options.eventName`, else the span's `failure.eventName`, else `exception`. A failure
 * recorded here and escaping later only sets the spans' status. Suppressed: a no-op. Tracing off:
 * the exception record alone goes to the process fallback sink, when one is registered
 * (`registerFallback`), else nowhere.
 */
export function* recordFailure(
  failure: Result.Failure<unknown>,
  options: TraceDef.RecordOptions = {},
): Operation<void> {
  yield* recordChecked(activeOf(yield* useScope()), failure, options)
}

/**
 * The failure was ANSWERED — the edge or a carrier encoded it into a reply with `status`: settle
 * it now (in the active span's local trace) instead of when an ancestor ends. Call it BEFORE the
 * span that answers ends: a failure that reaches an ancestor ending successfully counts as handled
 * (WARN). `status >= 500` ⇒ ERROR, every span it escaped fails; below ⇒ WARN, only CLIENT spans
 * fail. A failure that is not pending here is left alone.
 */
export function* settle(
  failure: Result.Failure<unknown>,
  options: TraceDef.SettleOptions = {},
): Operation<void> {
  const trace = activeOf(yield* useScope())?.trace

  if (trace) {
    yield* settleIn(trace, failure, options.status)
  }
}

/**
 * Mark `failure` recorded in trace `traceId` (another party recorded it). `remote: true` — a
 * decoder of a wire reply whose sender said it recorded the failure: the spans it escapes here
 * take `ozaco.failure.remote = true` (their exception is on the other side), no exception of
 * their own.
 */
export const markRecorded = (
  failure: Result.Failure<unknown>,
  traceId: string,
  options: TraceDef.MarkOptions = {},
): void => markRecordedIn(failure, traceId, options.remote === true)

/** Whether `failure` was recorded in trace `traceId` — by any std copy in this process. */
export const isRecorded = (failure: Result.Failure<unknown>, traceId: string): boolean =>
  isRecordedIn(failure, traceId)
