import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import { ActiveSpan, Suppressed, Tracing, TracingState } from '../definition'
import { handleIn } from '../internal/active'
import { anchorNow, timeOf } from '../internal/clock'
import { activeOf, isOn } from '../internal/context'
import { SpanRecorder } from '../internal/recorder'
import { plainContext } from '../internal/tree'
import type { TraceDef } from '../types/trace'

/** The active span's handle; a no-op handle when there is none (or telemetry is suppressed). */
export function* current(): Operation<TraceDef.SpanHandle> {
  return handleIn(yield* useScope())
}

/**
 * The active span's context — recording, non-recording or a pass-through inbound one (also under
 * suppression, for log correlation); `null` when there is none. Ids are W3C hex.
 */
export function* activeContext(): Operation<TraceDef.SpanContext | null> {
  const active = activeOf(yield* useScope())

  return active ? plainContext(active.context) : null
}

/**
 * A PASS-THROUGH value for `ActiveSpan`: an inbound context carried unchanged while tracing is
 * off — `inject()` forwards it as received, a span opened under it (tracing on) continues its
 * trace as a local root. `yield* ActiveSpan.with(passThrough(context), () => body)`.
 */
export const passThrough = (context: TraceDef.SpanContext): TraceDef.ActiveRecorder =>
  SpanRecorder.passThrough(context)

/**
 * Turn tracing on (or off) for the CURRENT scope: its own {@link TracingState} (created when the
 * scope has none of its own — a parent's is never flipped) set to `enabled`, returned so the
 * caller can flip it later (every fork sees the flip: `Tracing` is live). A `Tracer` impl calls it
 * in `setup`. It also pins `ActiveSpan` (`null`) and `Suppressed` in the scope when they are unset,
 * so forks created from here on hold their own snapshot.
 */
export function* enableTracing(enabled = true): Operation<TracingState> {
  const scope = yield* useScope()
  const own = scope.hasOwn(Tracing) ? scope.get(Tracing) : undefined

  const state = own ?? new TracingState(enabled)
  state.enabled = enabled

  if (!own) {
    scope.set(Tracing, state)
  }

  // nothing active anywhere up the chain: pin an own `null`, or every fork created from here on
  // would read a later `ActiveSpan.with` of this scope through the prototype chain
  if (!scope.hasOwn(ActiveSpan) && scope.get(ActiveSpan) === null) {
    scope.set(ActiveSpan, null)
  }

  if (!scope.hasOwn(Suppressed)) {
    scope.set(Suppressed, scope.get(Suppressed) === true)
  }

  return state
}

/** The tracing state in effect here (the nearest scope's), if any. */
export function* tracingState(): Operation<TracingState | undefined> {
  return (yield* useScope()).get(Tracing)
}

/** Whether spans would be recorded here: tracing on and not suppressed. */
export function* isTracing(): Operation<boolean> {
  return isOn(yield* useScope())
}

/** Now on the active local trace's anchored clock (epoch ms), else on the clock a new local root
 * anchors to (the process one, sub-millisecond) — a `startTime` taken here and handed to a root
 * `span` / `startSpan` reads the same time line as its children. */
export function* traceNow(): Operation<number> {
  return activeOf(yield* useScope())?.now() ?? timeOf(anchorNow())
}
