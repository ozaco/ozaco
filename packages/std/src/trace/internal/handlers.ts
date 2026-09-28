import type { Operation } from 'std:effect'
import { attempt, useScope } from 'std:effect'
import type { Result } from 'std:result'
import { isFailure } from 'std:result'

import type { TraceDef } from '../types/trace'

import { handleIn } from './active'
import { attributesOf } from './attributes'
import { anchorNow, timeOf } from './clock'
import { FLAG_RANDOM, MAX_ATTRIBUTES, MAX_VALUE_BYTES, PROTECTED_PREFIX, SEVERITY } from './const'
import {
  ActiveSpan,
  activeOf,
  isOn,
  isSuppressed,
  quiet,
  Suppressed,
  TraceIds,
  Tracing,
  TracingState,
} from './context'
import { exceptionAttributes } from './exception'
import { addSink, fallbackFor, sendFallback } from './fallback'
import { mintSpanId, mintTraceId } from './ids'
import { logOf } from './log'
import { extract as extractFrom, isValidContext, setTracestate, traceparentOf } from './propagation'
import { SpanRecorder } from './recorder'
import { isRecordedIn, markRecordedIn } from './registry'
import { deliverLog, finish, recordChecked, settleIn } from './settle'
import { idleOf, liveOf, open } from './span'
import { plainContext } from './tree'

/** `attributes` with every key an exception attribute takes moved to `ozaco.data.<key>`. */
const besideException = (
  attributes: TraceDef.AttributesInput | undefined,
  exception: TraceDef.Attributes,
): TraceDef.AttributesInput => {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(attributes ?? {})) {
    out[key in exception ? `${PROTECTED_PREFIX}${key}` : key] = value
  }

  return { ...out, ...exception }
}

// the handlers behind `Trace.actions.*` — their contracts are documented on `TraceDef.Handlers`

export function* startSpan(
  name: string,
  options: TraceDef.SpanOptions = {},
): Operation<TraceDef.LiveSpan> {
  const scope = yield* useScope()
  const rec = open(scope, name, options)

  return rec ? liveOf(rec) : idleOf(handleIn(scope))
}

export function* span<T>(
  name: string,
  optionsOrBody: TraceDef.SpanOptions | TraceDef.Body<T>,
  maybeBody?: TraceDef.Body<T>,
): Operation<T> {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody
  // the overloads guarantee a body in one of the two places
  const body = (typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody) as TraceDef.Body<T>
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

export function* current(): Operation<TraceDef.SpanHandle> {
  return handleIn(yield* useScope())
}

export function* activeContext(): Operation<TraceDef.SpanContext | null> {
  const active = activeOf(yield* useScope())

  if (!active) {
    return null
  }

  const { state } = active.context

  // its `tracestate` too: a context re-entered from here (`passThrough`) propagates as it came
  return state ? { ...plainContext(active.context), state } : plainContext(active.context)
}

export function* passThrough<T>(
  context: TraceDef.SpanContext,
  body: () => Operation<T>,
): Operation<T> {
  // an invalid context carries nothing: the body runs as it would without one
  if (!isValidContext(context)) {
    return yield* body()
  }

  return yield* ActiveSpan.with(SpanRecorder.passThrough(context), body)
}

export function* detached<T>(body: () => Operation<T>): Operation<T> {
  return yield* ActiveSpan.with(null, body)
}

export function* activate(
  target: TraceDef.LiveSpan | TraceDef.SpanContext | null | undefined,
): Operation<() => void> {
  const scope = yield* useScope()
  const own = scope.hasOwn(ActiveSpan)
  const prior = scope.get(ActiveSpan)

  if (target === null) {
    scope.set(ActiveSpan, null)
  } else if (target !== undefined && 'run' in target) {
    scope.set(ActiveSpan, (yield* target.run(() => ActiveSpan.get())) ?? null)
  } else if (target !== undefined && isValidContext(target)) {
    scope.set(ActiveSpan, SpanRecorder.passThrough(target))
  }

  return () => {
    try {
      if (own) {
        scope.set(ActiveSpan, prior ?? null)
      } else {
        scope.delete(ActiveSpan)
      }
    } catch {
      // the scope is already gone
    }
  }
}

export function* event(
  name: string,
  attributes?: TraceDef.AttributesInput,
  options: TraceDef.EventOptions = {},
): Operation<void> {
  const scope = yield* useScope()
  const on = isOn(scope)
  const sink = on ? undefined : fallbackFor(scope)

  if (!on && !sink) {
    return
  }

  const rec = activeOf(scope)
  const time = options.time ?? rec?.now() ?? Date.now()
  const log = logOf(rec, {
    body: options.body ?? name,
    severityNumber: options.severity ?? SEVERITY.info,
    eventName: name,
    attributes,
    time,
  })

  if (sink) {
    yield* sendFallback(sink, log)

    return
  }

  rec?.addEvent(name, attributes, time)

  yield* deliverLog(rec?.trace ?? null, log)
}

export function* emitLog(input: TraceDef.LogInput): Operation<void> {
  const scope = yield* useScope()
  const on = isOn(scope)
  const sink = on ? undefined : fallbackFor(scope)

  if (!on && !sink) {
    return
  }

  const { failure, omitRecorded, ...line } = input
  const rec = activeOf(scope)
  let attributes = line.attributes

  if (failure) {
    const handle = handleIn(scope)
    const serious = line.severityNumber >= SEVERITY.warn

    if (serious && handle.recording) {
      const fresh = !isRecordedIn(failure, handle.context.traceId)

      if (fresh) {
        yield* recordChecked(rec, failure, { severity: line.severityNumber })
      }

      if (fresh && omitRecorded) {
        return
      }
    } else {
      const context = line.context === undefined ? rec?.context : line.context
      const traceId = context?.traceId ?? ''

      // already an exception record in this trace: the line stays a plain line
      if (!isRecordedIn(failure, traceId)) {
        attributes = besideException(attributes, exceptionAttributes(failure))

        if (serious) {
          markRecordedIn(failure, traceId)
        }
      }
    }
  }

  const log = logOf(rec, { ...line, attributes })

  yield* sink ? sendFallback(sink, log) : deliverLog(rec?.trace ?? null, log)
}

export function* recordFailure(
  failure: Result.Failure<unknown>,
  options: TraceDef.RecordOptions = {},
): Operation<void> {
  yield* recordChecked(activeOf(yield* useScope()), failure, options)
}

export function* settle(
  failure: Result.Failure<unknown>,
  options: TraceDef.SettleOptions = {},
): Operation<void> {
  const trace = activeOf(yield* useScope())?.trace

  if (trace) {
    yield* settleIn(trace, failure, options.status)
  }
}

export function* markRecorded(
  failure: Result.Failure<unknown>,
  traceId: string,
  options: TraceDef.MarkOptions = {},
): Operation<void> {
  markRecordedIn(failure, traceId, options.remote === true)
}

export function* isRecorded(failure: Result.Failure<unknown>, traceId: string): Operation<boolean> {
  return isRecordedIn(failure, traceId)
}

export function* inject(options: TraceDef.InjectOptions = {}): Operation<TraceDef.Carrier> {
  const scope = yield* useScope()
  const active = activeOf(scope)
  const context = options.context ?? active?.context

  // nothing to write, or ids no W3C header can carry
  if (!context || !isValidContext(context)) {
    return {}
  }

  // an explicit context is written as it is; the active one follows the suppression
  const quieted = options.context === undefined && isSuppressed(scope)
  // suppressed: NOT sampled — the random bit stays (W3C: a trace id's random flag MUST go out as
  // it came in / was minted, whatever the sampling decision)
  const traceparent = traceparentOf(
    quieted ? { ...context, flags: context.flags & FLAG_RANDOM } : context,
  )
  const recording = options.context === undefined && active?.recording === true
  const state =
    options.ozaco && !quieted && recording
      ? setTracestate(context.state, 'ozaco', '1')
      : context.state

  return state ? { traceparent, tracestate: state } : { traceparent }
}

export function* extract(
  source: TraceDef.Getter | TraceDef.Carrier,
): Operation<TraceDef.SpanContext | null> {
  return extractFrom(source)
}

export function* suppressed<T>(body: () => Operation<T>): Operation<T> {
  return yield* quiet(body)
}

export function* enableTracing(enabled = true): Operation<TraceDef.TracingState> {
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

export function* isTracing(): Operation<boolean> {
  return isOn(yield* useScope())
}

export function* isSuppressedHere(): Operation<boolean> {
  return isSuppressed(yield* useScope())
}

export function* canEmit(): Operation<boolean> {
  const scope = yield* useScope()

  return isOn(scope) || fallbackFor(scope) !== undefined
}

export function* traceNow(): Operation<number> {
  return activeOf(yield* useScope())?.now() ?? timeOf(anchorNow())
}

export function* newTraceId(): Operation<string> {
  return mintTraceId(yield* useScope())
}

export function* newSpanId(): Operation<string> {
  return mintSpanId(yield* useScope())
}

export function* useIds(ids: TraceDef.Ids): Operation<void> {
  yield* TraceIds.set(ids)
}

export function* registerFallback(sink: TraceDef.FallbackSink): Operation<() => void> {
  // a fresh entry per registration: the same sink registered twice leaves as two
  return addSink({ id: sink.id, emit: log => sink.emit(log) })
}

export function* toAttributes(
  input: TraceDef.AttributesInput | undefined,
  options: TraceDef.AttributeOptions = {},
): Operation<{ attributes: TraceDef.Attributes; dropped: number }> {
  return attributesOf(
    input,
    options.maxBytes ?? MAX_VALUE_BYTES,
    options.maxCount ?? MAX_ATTRIBUTES,
  )
}
