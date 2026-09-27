import type { Operation, Scope } from 'std:effect'

import { ActiveSpan, Suppressed, Tracing } from '../definition'
import type { TraceDef } from '../types/trace'

import { SpanRecorder } from './recorder'
import { isRecorder } from './tree'

/** The recorder `ActiveSpan` holds in `scope` (any std copy's), else `null`. */
export const activeOf = (scope: Scope): SpanRecorder | null => {
  const value = scope.get(ActiveSpan)

  return isRecorder(value) ? value : null
}

export const isSuppressed = (scope: Scope): boolean => scope.get(Suppressed) === true

/** Tracing is on in `scope` and not suppressed. */
export const isOn = (scope: Scope): boolean =>
  scope.get(Tracing)?.enabled === true && !isSuppressed(scope)

/** Run `op` suppressed: nothing it does is traced, and it cannot recurse into telemetry. */
export const quiet = <T>(op: () => Operation<T>): Operation<T> => Suppressed.with(true, op)

/**
 * Hand `log` to its receivers: `op` runs suppressed (see {@link quiet}) with the record's own span
 * context as the ACTIVE one — a pass-through, nothing is written to a span. A receiver that shows
 * the record elsewhere (a Tracer forwarding an exception record to the Logger) correlates it to the
 * span the record belongs to, not to whatever span is active where the failure settled.
 */
export const quietFor = <T>(log: TraceDef.LogData, op: () => Operation<T>): Operation<T> =>
  quiet(() => (log.context ? ActiveSpan.with(SpanRecorder.passThrough(log.context), op) : op()))
