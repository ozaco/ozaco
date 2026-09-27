import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import { isOn } from '../internal/context'
import { addSink, fallbackFor } from '../internal/fallback'
import type { TraceDef } from '../types/trace'

/**
 * Register a PROCESS-LEVEL fallback for log records emitted where no scope Tracer records:
 * tracing off (or never enabled) there and telemetry not suppressed — a Logger line of
 * infrastructure installed outside every observing node (through a `TraceTransport` visible where
 * it logs), an `emitLog` / `event()` / `recordFailure` there. Such a record — correlated to the
 * active pass-through / span context there, else to none — goes to the FIRST registered sink
 * only; later registrations queue behind it and take over, in order, as the ones before them
 * unregister. Spans never reach a fallback (none is recorded without tracing in scope).
 *
 * The queue lives on `globalThis` (`Symbol.for('std:trace.fallback')`), shared by every std copy
 * in the process. Returns the unregister function (idempotent). With nothing registered the
 * routing costs one property read.
 */
export const registerFallback = (sink: TraceDef.FallbackSink): (() => void) =>
  // a fresh entry per registration: the same sink registered twice leaves as two
  addSink({ id: sink.id, emit: log => sink.emit(log) })

/**
 * Whether a log record emitted here goes anywhere: tracing is on (and not suppressed) — to the
 * scope's Tracers — or, tracing off and not suppressed, a fallback sink is registered. What a
 * bridge checks before it maps a record nobody would receive.
 */
export function* canEmit(): Operation<boolean> {
  const scope = yield* useScope()

  return isOn(scope) || fallbackFor(scope) !== undefined
}
