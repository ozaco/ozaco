import type { Scope } from 'std:effect'

import type { TraceDef } from '../types/trace'

import { activeOf, isOn, isSuppressed } from './context'
import { NOOP_HANDLE } from './handle'

/**
 * The handle span code sees in `scope`: the active span's (recording, non-recording or a
 * pass-through); the no-op one when there is none or telemetry is suppressed. Where tracing is OFF
 * a recording span of an outer, traced scope stays visible (its context propagates) but is never
 * writable from here: its context with the no-op mutators.
 */
export const handleIn = (scope: Scope): TraceDef.SpanHandle => {
  const active = isSuppressed(scope) ? null : activeOf(scope)

  if (!active) {
    return NOOP_HANDLE
  }

  return active.recording && !isOn(scope)
    ? { ...NOOP_HANDLE, context: active.context }
    : active.handle
}
