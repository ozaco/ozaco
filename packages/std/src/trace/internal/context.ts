import type { Context, Operation, Scope } from 'std:effect'
import { createContext, markContextAsSnapshot } from 'std:effect'

import type { TraceDef } from '../types/trace'

import { SpanRecorder } from './recorder'
import { isRecorder } from './tree'

/**
 * Whether spans are recorded in a scope — the value of the LIVE {@link Tracing} context. A class
 * instance, so a flip made after forks were created is seen by all of them (a snapshot context
 * would have copied a plain object into every fork).
 */
export class TracingState implements TraceDef.TracingState {
  enabled: boolean

  constructor(enabled = false) {
    this.enabled = enabled
  }
}

/**
 * The span the running operation belongs to: a recording / non-recording span, a pass-through
 * inbound context, or `null` (none). A SNAPSHOT context holding class instances: every fork of a
 * span body shares the one recorder.
 */
export const ActiveSpan: Context<TraceDef.ActiveRecorder | null> = markContextAsSnapshot(
  // default `null` (not `undefined`): an own `null` survives `ActiveSpan.with` restoring it
  createContext<TraceDef.ActiveRecorder | null>('std:trace.span', null),
)

/** Whether tracing is on here — LIVE (never snapshot). Set by `enableTracing`. */
export const Tracing: Context<TracingState> = createContext<TracingState>('std:trace.state')

/** Telemetry-internal code runs suppressed: no spans, no records, unsampled propagation. */
export const Suppressed: Context<boolean> = markContextAsSnapshot(
  createContext<boolean>('std:trace.suppressed', false),
)

/** Pins trace / span id generation (tests); default `crypto.getRandomValues`. */
export const TraceIds: Context<TraceDef.Ids> = createContext<TraceDef.Ids>('std:trace.ids')

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
 * the record elsewhere (a sink forwarding an exception record to the Logger) correlates it to the
 * span the record belongs to, not to whatever span is active where the failure settled.
 */
export const quietFor = <T>(log: TraceDef.LogData, op: () => Operation<T>): Operation<T> =>
  quiet(() => (log.context ? ActiveSpan.with(SpanRecorder.passThrough(log.context), op) : op()))
