import pkg from '../../../package.json'
import type { TraceDef } from '../types/trace'

/** The subtype of the `Trace` protocol and its impls. */
export const TRACE = Symbol.for('std:trace.trace')

/** Attributes, events and links per span (per event / link for their own attributes). */
export const MAX_ATTRIBUTES = 128
export const MAX_EVENTS = 128
export const MAX_LINKS = 128

/** Items one array attribute value keeps (the first ones) — a value never grows without bound. */
export const MAX_ARRAY_ITEMS = 128

/** A span / event / link attribute string value (UTF-8 bytes) — Tempo's `max_attribute_bytes`. */
export const MAX_VALUE_BYTES = 2048

/** A log record attribute string value and a log body (UTF-8 bytes). */
export const LOG_VALUE_BYTES = 16_384

/** How many object levels below an attribute key are flattened into dotted keys. */
export const FLATTEN_DEPTH = 3

/** Failures parked per local trace before the oldest is settled as handled. */
export const MAX_PENDING = 128

/** Spans / log records a `record: 'errors'` local trace buffers before it decides. */
export const MAX_BUFFERED = 256

export const FLAG_SAMPLED = 0x01
export const FLAG_RANDOM = 0x02

/** The trace flag bits propagated (and kept from a `traceparent`): sampled and random. */
export const KNOWN_FLAGS = FLAG_SAMPLED | FLAG_RANDOM

/** A `traceparent`'s version / flags field, trace id and span id (lowercase hex). */
export const HEX2 = /^[\da-f]{2}$/u
export const TRACE_ID = /^[\da-f]{32}$/u
export const SPAN_ID = /^[\da-f]{16}$/u

// W3C tracestate grammar: a key starts with a lowercase letter or digit (≤ 256 chars of
// `a-z 0-9 _ - * / @`); a value is ≤ 256 printable ASCII chars except `,` and `=`, not ending
// in a space
export const STATE_KEY = /^[\da-z][\d_a-z\-*/@]{0,255}$/u
export const STATE_VALUE =
  /^[\u0020-\u002B\u002D-\u003C\u003E-\u007E]{0,255}[\u0021-\u002B\u002D-\u003C\u003E-\u007E]$/u
export const MAX_STATE_MEMBERS = 32

/** OTel severity numbers. */
export { TraceSeverity as SEVERITY } from '../const'

/** The first server-error status: the class of a failure no classifier claimed (a thrown error),
 * and the line above which every span a failure escaped fails. */
export const SERVER_ERROR = 500

export const EXCEPTION_EVENT = 'exception'

/** Where a log line's own attribute goes when an exception attribute takes its key. */
export const PROTECTED_PREFIX = 'ozaco.data.'

/** Trace ids remembered per recorded failure (the latest ones — a long-lived shared failure object
 * must not grow the registry without bound). */
export const MAX_RECORDED_TRACES = 128

/** One registry across std copies: `WeakMap<failure | error object, Set<traceId>>`. */
export const RECORDED_KEY = Symbol.for('std:trace.recorded')

/** The same shape for the failures the other side of a wire recorded (`markRecorded` `remote`). */
export const REMOTE_KEY = Symbol.for('std:trace.remote')

/** The remote span that recorded a failure, when the reply named it: `WeakMap<failure, SpanContext>`. */
export const RECORDER_KEY = Symbol.for('std:trace.recorder-of')

/** One process-level fallback queue across std copies: `readonly FallbackSink[]`, the first one
 * receives (`registerFallback`). */
export const FALLBACK_KEY = Symbol.for('std:trace.fallback')

/** Brands a recorder so another std copy's `ActiveSpan` value is still recognised. */
export const RECORDER_BRAND = Symbol.for('std:trace.recorder')

/** The scope of what std:trace records itself: a log record emitted outside of any span. */
export const DEFAULT_SCOPE: TraceDef.InstrumentationScope = Object.freeze({
  name: '@ozaco/std',
  version: pkg.version,
})

/** The scope of a span opened without one, with no service and no non-library parent scope. */
export const APP_SCOPE: TraceDef.InstrumentationScope = Object.freeze({ name: 'app' })

/** The instrumentation scopes of the ozaco libraries (`@ozaco/server`, `@ozaco/db`, …) — a span
 * opened without a scope never inherits one of them. */
export const LIBRARY_SCOPE_PREFIX = '@ozaco/'

export const INVALID_TRACE_ID = '0'.repeat(32)
export const INVALID_SPAN_ID = '0'.repeat(16)

/** How far a trace's clock may drift from `Date.now()` before the process anchor is taken anew
 * (a suspended machine stops the monotonic clock; an NTP step moves the wall clock). */
export const MAX_CLOCK_DRIFT_MS = 1000
