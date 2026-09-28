import type { Operation } from 'std:effect'
import { attempt, EffectErrors, useScope } from 'std:effect'
import type { Result } from 'std:result'

import { Trace } from '../definition'
import { TraceCauses } from '../errors'
import type { Helpers } from '../types/helpers'
import type { TraceDef } from '../types/trace'

import { nestedIn } from './chain'
import { clamp } from './clock'
import { EXCEPTION_EVENT, MAX_BUFFERED, MAX_PENDING, SERVER_ERROR, SEVERITY } from './const'
import { activeOf, isOn, quiet, quietFor } from './context'
import { exceptionAttributes, exceptionType } from './exception'
import { fallbackFor, sendFallback } from './fallback'
import { logOf } from './log'
import type { LocalTrace, SpanRecorder } from './recorder'
import { isRecordedIn, isRemoteIn, markRecordedIn } from './registry'
import { isBelow } from './tree'

// --- delivery -----------------------------------------------------------------------------------

/** Hand a span to every sink — suppressed (no recursion) and attempted (never fails the caller). */
function* sendSpan(data: TraceDef.SpanData): Operation<void> {
  yield* attempt(() => quiet(() => Trace.actions.export(data)), TraceCauses.Export)
}

/** Hand a log record to every sink — suppressed, correlated to the record's own span
 * ({@link quietFor}), attempted (never fails the caller). */
function* sendLog(log: TraceDef.LogData): Operation<void> {
  yield* attempt(() => quietFor(log, () => Trace.actions.emit(log)), TraceCauses.Emit)
}

/** A span of `trace`, through its `record` mode: buffered while an `'errors'` trace is open. */
function* deliverSpan(trace: LocalTrace, data: TraceDef.SpanData): Operation<void> {
  if (trace.decision === 'open') {
    if (trace.spans.length < MAX_BUFFERED) {
      trace.spans.push(data)
    }

    return
  }

  // a late span of a dropped trace still surfaces when it failed
  if (trace.decision === 'drop' && data.status.code !== 'error') {
    return
  }

  yield* sendSpan(data)
}

/** Export a finished recording span once. */
function* exportRecorder(rec: SpanRecorder): Operation<void> {
  if (!rec.trace || !rec.recording || rec.exported || !rec.ended) {
    return
  }

  rec.exported = true
  yield* deliverSpan(rec.trace, rec.toSpanData())
}

/** A local root ended: an `'errors'` trace now keeps (exports) or drops what it buffered. */
function* close(trace: LocalTrace): Operation<void> {
  if (trace.decision !== 'open') {
    return
  }

  const keep = trace.failed || trace.spans.some(data => data.status.code === 'error')

  trace.decision = keep ? 'keep' : 'drop'

  const spans = trace.spans.splice(0)
  const logs = trace.logs.splice(0)

  if (!keep) {
    return
  }

  for (const data of spans) {
    yield* sendSpan(data)
  }

  for (const log of logs) {
    yield* sendLog(log)
  }
}

// --- recording ----------------------------------------------------------------------------------

/** When a failure was created (`fail()` stamps `_d`). */
const failureTime = (failure: Result.Failure<unknown>): number =>
  typeof failure._d === 'number' && Number.isFinite(failure._d) ? failure._d : Date.now()

/**
 * Where a failure recorded at `rec` lands: `rec` itself when it records, else — a span opted out
 * of sampling (`sampled: false`) under a recording one — its nearest recording ancestor that is not
 * exported yet, so the `exception` event sits on an exported span and the record points at one. A
 * trace nobody records (unsampled) keeps `rec`.
 */
const targetOf = (rec: SpanRecorder): SpanRecorder => {
  for (let node: SpanRecorder | null = rec; node !== null; node = node.local) {
    if (node.recording && !node.exported) {
      return node
    }
  }

  return rec
}

/** The ONE exception log record recorded at `rec` from the failure's `attributes`
 * (`exceptionAttributes`, rendered once): the whole chain as its body. */
const exceptionLog = (
  rec: SpanRecorder | null,
  attributes: TraceDef.Attributes,
  how: Helpers.RecordHow,
): TraceDef.LogData =>
  logOf(rec, {
    body: String(attributes['exception.stacktrace'] || attributes['exception.type']),
    severityNumber: how.severity,
    eventName: how.eventName,
    attributes,
    time: how.time,
  })

/** `recordFailure`'s defaults at `rec`: severity 13 handled / 17 not, the span's exception event
 * name, the failure's own time clamped into the span. */
const howOf = (
  rec: SpanRecorder | null,
  failure: Result.Failure<unknown>,
  options: TraceDef.RecordOptions,
): Helpers.RecordHow => {
  const created = failureTime(failure)

  return {
    severity: options.severity ?? (options.handled ? SEVERITY.warn : SEVERITY.error),
    eventName: options.eventName ?? rec?.failure?.eventName ?? EXCEPTION_EVENT,
    time:
      rec && !rec.passThrough
        ? clamp(created, rec.start, rec.ended ? rec.end : rec.now())
        : created,
  }
}

/**
 * Record `failure` at `rec` — once per (failure, trace): the `exception` span event (its values
 * under the span value cap) when the span records, and ONE exception log record
 * (the whole chain as its body) even when it does not.
 */
function* recordAt(
  at: SpanRecorder | null,
  failure: Result.Failure<unknown>,
  how: Helpers.RecordHow,
): Operation<void> {
  const rec = at && targetOf(at)
  const traceId = rec?.context.traceId ?? ''

  if (isRecordedIn(failure, traceId)) {
    return
  }

  markRecordedIn(failure, traceId)

  // the chain rendered ONCE, for the span event and the log record both
  const attributes = exceptionAttributes(failure)

  if (rec?.recording) {
    rec.pushException(attributes, how.time)
  }

  if (rec?.trace) {
    rec.trace.failed = true
  }

  yield* deliverLog(rec?.trace ?? null, exceptionLog(rec, attributes, how))
}

/**
 * The exception record of `failure` at `rec` for the process FALLBACK sink — once per (failure,
 * trace): `null` when it was recorded there already. The span is never written (tracing is off
 * where it is recorded).
 */
const fallbackRecord = (
  rec: SpanRecorder | null,
  failure: Result.Failure<unknown>,
  options: TraceDef.RecordOptions,
): TraceDef.LogData | null => {
  const traceId = rec?.context.traceId ?? ''

  if (isRecordedIn(failure, traceId)) {
    return null
  }

  markRecordedIn(failure, traceId)

  return exceptionLog(rec, exceptionAttributes(failure), howOf(rec, failure, options))
}

// --- hold-until-settled -------------------------------------------------------------------------

const isHalt = (failure: Result.Failure<unknown>): boolean => failure.error === EffectErrors.Halted

const statusOf = (entry: Helpers.Pending, explicit: number | undefined): number => {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit
  }

  try {
    const code = entry.status?.(entry.failure)

    return typeof code === 'number' && Number.isFinite(code) ? code : SERVER_ERROR
  } catch {
    return SERVER_ERROR
  }
}

const typeOf = (
  classify: ((failure: Result.Failure<unknown>) => string) | undefined,
  failure: Result.Failure<unknown>,
): string => {
  try {
    const type = classify?.(failure)

    return typeof type === 'string' && type ? type : exceptionType(failure)
  } catch {
    return exceptionType(failure)
  }
}

/**
 * The settled status on a span the failure escaped: `error.type` always (and
 * `ozaco.failure.remote` when the other side of a wire recorded it). A HANDLED failure (retried,
 * replaced by a fallback, caught) leaves the status unset; otherwise `>= 500` fails every kind and
 * below that only CLIENT spans fail (a client-caused failure is no server error) — the status
 * message is the `exception.message` text (a thrown `Error`'s own message, never its fold's
 * `Name: message`), else the `error.type`. A halt is no failure: `ozaco.cancelled`, status unset.
 */
const applyTo = (
  rec: SpanRecorder,
  failure: Result.Failure<unknown>,
  verdict: Helpers.Verdict,
): void => {
  if (isHalt(failure)) {
    rec.mark('ozaco.cancelled', true)

    return
  }

  rec.mark('error.type', verdict.type)

  if (isRemoteIn(failure, rec.context.traceId)) {
    rec.mark('ozaco.failure.remote', true)
  }

  if (!verdict.handled && (verdict.code >= SERVER_ERROR || rec.kind === 'client')) {
    rec.fail(failure.message || verdict.type)
  }
}

/** The outermost span's classifiers win: each span the failure escapes overrides what it sets. */
const adopt = (entry: Helpers.Pending, rec: SpanRecorder): void => {
  const options = rec.failure

  if (options?.status) {
    entry.status = options.status
  }

  if (options?.type) {
    entry.type = options.type
  }

  if (options?.handledSeverity !== undefined) {
    entry.handledSeverity = options.handledSeverity
  }
}

/** The spans waiting on a pending failure: those it escaped and those it unwound. */
const waiting = (entry: Helpers.Pending): SpanRecorder[] => [...entry.held, ...entry.unwound]

/** Pending failures one of whose spans ran strictly inside `rec`. */
const below = (trace: LocalTrace, rec: SpanRecorder): Helpers.Pending[] =>
  [...trace.pending.values()].filter(entry =>
    waiting(entry).some(span => span !== rec && isBelow(span, rec)),
  )

/** The failure last escaped a span opened in the task `rec` was opened in: its body caught it. */
const caughtIn = (entry: Helpers.Pending, rec: SpanRecorder): boolean => {
  const last = entry.held.at(-1)

  return last !== undefined && rec.opener !== null && last.opener === rec.opener
}

/** Pending failures waited on by `rec` or by a span inside it. */
const within = (trace: LocalTrace, rec: SpanRecorder): Helpers.Pending[] =>
  [...trace.pending.values()].filter(entry =>
    waiting(entry).some(span => span === rec || isBelow(span, rec)),
  )

const heldOf = (entry: Helpers.Pending): SpanRecorder[] => [
  ...waiting(entry),
  ...entry.absorbed.flatMap(inner => heldOf(inner)),
]

/**
 * Take the pending failures `failure` wraps (however deep in its causes) off the pending map: they
 * are ABSORBED by it (their spans take its settled status, no exception of their own).
 */
const absorbedBy = (trace: LocalTrace, failure: Result.Failure<unknown>): Helpers.Pending[] => {
  const nested = nestedIn(failure)

  const absorbed = [...trace.pending.values()].filter(
    entry => entry.failure !== failure && nested.has(entry.failure),
  )

  for (const entry of absorbed) {
    trace.pending.delete(entry.failure)
  }

  return absorbed
}

/**
 * A failure is first seen at `rec`: park it, absorbing the pending failures it wraps. The
 * exception goes to an absorbed failure's origin only when this one was created while that span
 * still ran; otherwise to `rec`, the span that wrapped it.
 */
const park = (
  trace: LocalTrace,
  rec: SpanRecorder,
  failure: Result.Failure<unknown>,
): Helpers.Pending => {
  const absorbed = absorbedBy(trace, failure)
  const created = failureTime(failure)
  // `_d` has whole milliseconds: only a strictly earlier millisecond proves "while it ran"
  const inner = absorbed.find(entry => created < Math.floor(entry.origin.end))
  const origin = inner?.origin ?? rec

  const entry: Helpers.Pending = {
    failure,
    origin,
    time: clamp(created, origin.start, origin.end),
    eventName: origin.failure?.eventName,
    held: [rec],
    unwound: [],
    absorbed,
    status: undefined,
    type: undefined,
    handledSeverity: undefined,
  }

  adopt(entry, rec)
  trace.pending.set(failure, entry)

  return entry
}

/**
 * SETTLE a parked failure with its final state: every span it escaped (and every absorbed
 * failure's) gets `error.type` and its status; the origin gets the ONE `exception` event and the
 * one exception log record (unless the failure was already recorded in this trace); the held spans
 * are exported. Severity: handled `handledSeverity ?? 13`, cancelled 5, `>= 500` 17, else 13.
 */
function* settleEntry(
  trace: LocalTrace,
  entry: Helpers.Pending,
  how: Helpers.SettleHow,
): Operation<void> {
  if (trace.pending.get(entry.failure) === entry) {
    trace.pending.delete(entry.failure)
  }

  const { failure, origin } = entry
  const traceId = origin.context.traceId
  const code = statusOf(entry, how.status)
  const handled = how.handled === true

  const verdict: Helpers.Verdict = { code, type: typeOf(entry.type, failure), handled }

  for (const held of entry.held) {
    applyTo(held, failure, verdict)
  }

  // halted while it was pending: unwound by it only if it kept going, else simply cancelled
  for (const unwound of entry.unwound) {
    if (handled) {
      unwound.mark('ozaco.cancelled', true)
    } else {
      applyTo(unwound, failure, verdict)
    }
  }

  const absorb = (outer: Helpers.Pending): void => {
    for (const inner of outer.absorbed) {
      const own: Helpers.Verdict = {
        code,
        type: typeOf(inner.type ?? entry.type, inner.failure),
        handled,
      }

      for (const held of [...inner.held, ...inner.unwound]) {
        applyTo(held, inner.failure, own)
      }

      markRecordedIn(inner.failure, traceId)
      absorb(inner)
    }
  }

  absorb(entry)

  trace.failed = true

  if (!isRecordedIn(failure, traceId)) {
    const severity = how.handled
      ? (entry.handledSeverity ?? SEVERITY.warn)
      : isHalt(failure)
        ? SEVERITY.debug
        : code >= SERVER_ERROR
          ? SEVERITY.error
          : SEVERITY.warn

    yield* recordAt(origin, failure, {
      severity,
      eventName: entry.eventName ?? EXCEPTION_EVENT,
      time: entry.time,
    })
  }

  const pending = [...trace.pending.values()]

  for (const held of heldOf(entry)) {
    // a span unwound with several failures waits for the last of them
    if (pending.some(other => waiting(other).includes(held))) {
      continue
    }

    held.held = false
    yield* exportRecorder(held)
  }
}

/** `rec` ended with `failure`: park it (or join it), and settle what `rec` handled below it. */
function* failed(
  trace: LocalTrace,
  rec: SpanRecorder,
  failure: Result.Failure<unknown>,
): Operation<void> {
  rec.held = true

  let entry = trace.pending.get(failure)

  if (entry) {
    entry.held.push(rec)
    entry.absorbed.push(...absorbedBy(trace, failure))
    adopt(entry, rec)
  } else {
    entry = park(trace, rec, failure)
  }

  // anything else still pending inside `rec` did not escape it: it was handled
  for (const other of below(trace, rec)) {
    if (other !== entry) {
      yield* settleEntry(trace, other, { handled: true })
    }
  }

  while (trace.pending.size > MAX_PENDING) {
    const oldest = trace.pending.values().next().value

    if (!oldest) {
      break
    }

    yield* settleEntry(trace, oldest, { handled: true })
  }
}

/** `finish` without its guard (see there). */
function* endSpan(rec: SpanRecorder, outcome: Helpers.Outcome, time?: number): Operation<void> {
  const { trace } = rec

  if (!trace || rec.ended) {
    return
  }

  rec.ended = true
  rec.end = Math.max(rec.start, time ?? trace.now())

  const boundary = rec.local === null || rec.local.ended

  if (outcome.t === 'failed') {
    yield* failed(trace, rec, outcome.failure)
  } else {
    const inner = below(trace, rec)

    // halted: a failure that last escaped a span of THIS task was caught by the body (uncaught, it
    // would have failed this span, not left it to be halted) — handled; one from another task may
    // be what is unwinding this span (a crashed child task halts its parents' frames first)
    const handled = outcome.t === 'ok' ? inner : inner.filter(entry => caughtIn(entry, rec))
    const unwinding = inner.filter(entry => !handled.includes(entry))

    for (const entry of handled) {
      yield* settleEntry(trace, entry, { handled: true })
    }

    if (unwinding.length > 0) {
      for (const entry of unwinding) {
        entry.unwound.push(rec)
      }

      rec.held = true
    } else if (outcome.t === 'halted') {
      rec.mark('ozaco.cancelled', true)
    }

    if (!rec.held) {
      yield* exportRecorder(rec)
    }
  }

  if (boundary) {
    const rest = rec.local === null ? [...trace.pending.values()] : within(trace, rec)

    for (const entry of rest) {
      yield* settleEntry(trace, entry, {})
    }
  }

  if (rec.local === null) {
    yield* close(trace)
  }
}

// --- the module's entry points --------------------------------------------------------------------

/** A log record, through the `record` mode of the local trace it belongs to (if any). */
export function* deliverLog(trace: LocalTrace | null, log: TraceDef.LogData): Operation<void> {
  if (trace && log.severityNumber >= SEVERITY.error) {
    trace.failed = true
  }

  if (trace?.decision === 'open') {
    if (trace.logs.length < MAX_BUFFERED) {
      trace.logs.push(log)
    }

    return
  }

  if (trace?.decision === 'drop' && log.severityNumber < SEVERITY.warn) {
    return
  }

  yield* sendLog(log)
}

/** `recordFailure` on `rec` (or on nothing), with its defaults. Never fails the caller. */
export function* recordOn(
  rec: SpanRecorder | null,
  failure: Result.Failure<unknown>,
  options: TraceDef.RecordOptions = {},
): Operation<void> {
  yield* attempt(() => recordAt(rec, failure, howOf(rec, failure, options)))
}

/**
 * `recordOn` while tracing is on (and not suppressed) where it is called. With tracing off there
 * (not suppressed) the exception record goes to the process FALLBACK sink, when one is registered:
 * the same record, correlated to `rec` (else the active span / pass-through context), once per
 * (failure, trace) — no span is touched (one of an outer, traced scope is not writable here).
 */
export function* recordChecked(
  rec: SpanRecorder | null,
  failure: Result.Failure<unknown>,
  options: TraceDef.RecordOptions = {},
): Operation<void> {
  const scope = yield* useScope()

  if (isOn(scope)) {
    yield* recordOn(rec, failure, options)

    return
  }

  const sink = fallbackFor(scope)

  if (!sink) {
    return
  }

  const at = rec ?? activeOf(scope)

  yield* attempt(function* () {
    const log = fallbackRecord(at, failure, options)

    if (log) {
      yield* sendFallback(sink, log)
    }
  })
}

/**
 * End `rec` (idempotent). Failure ⇒ park/join the failure (the span is held until it settles);
 * success ⇒ every failure pending inside it was handled; halt ⇒ a failure pending inside it that
 * last escaped a span of its own task was caught (handled), one from another task makes it wait (a
 * crashed child task unwinds its parents' frames before the failure surfaces), else
 * `ozaco.cancelled`. A LOCAL ROOT (or a span whose parent already ended) settles everything still
 * pending under it; a local root also closes its `record: 'errors'` buffer. Telemetry never fails
 * the traced code: whatever goes wrong here (a hostile `Error` getter while rendering) stays here.
 */
export function* finish(
  rec: SpanRecorder,
  outcome: Helpers.Outcome,
  time?: number,
): Operation<void> {
  yield* attempt(() => endSpan(rec, outcome, time))
}

/** `settle(failure, { status })`: the failure was answered — settle it in `trace` now. Never
 * fails the caller. */
export function* settleIn(
  trace: LocalTrace,
  failure: Result.Failure<unknown>,
  status: number | undefined,
): Operation<void> {
  const entry = trace.pending.get(failure)

  if (entry) {
    yield* attempt(() => settleEntry(trace, entry, { status }))
  }
}
