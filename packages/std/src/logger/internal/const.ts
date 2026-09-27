/** How many object / array levels below an object payload are searched for `Error`s / Failures. */
export const NESTED_DEPTH = 6

/** The object payload keys whose `Error` / Failure value IS the entry's failure (beside the
 * configured error key): lifted out of `data` like a bare failure payload. */
export const ERROR_KEYS: readonly string[] = ['err', 'error']

/** The JSON record's own trace-correlation keys (the OTel `logging_trace_context` names). */
export const TRACE_KEYS = {
  traceId: 'trace_id',
  spanId: 'span_id',
  flags: 'trace_flags',
} as const

/** Where a user key colliding with a reserved record key goes: `data.<key>`. */
export const MOVED_PREFIX = 'data.'

/** The routing marker `ctx.log` binds on entries it already emitted as telemetry
 * (`ozaco.telemetry = 'sent'`): the trace transport skips them, the printed forms leave it out. */
export const TELEMETRY_BINDING = 'ozaco.telemetry'
export const TELEMETRY_SENT = 'sent'

// --- the trace transport: logger lines as log records -------------------------------------------

/** Flattened leaves kept as attributes; the rest travel as one JSON string. */
export const MAX_LEAVES = 64

/** The UTF-8 cap of one attribute value (and of the overflow JSON string). */
export const VALUE_BYTES = 8192

/** The attribute holding the leaves past {@link MAX_LEAVES}, as a JSON object string. */
export const OVERFLOW_KEY = 'ozaco.log.data'

/** Where a user key colliding with a backend-reserved name goes: `ozaco.data.<key>`. */
export const PROTECTED_PREFIX = 'ozaco.data.'

/**
 * Field names the log backends keep for themselves (Loki structured metadata / labels,
 * OpenObserve columns), in their normalized form: an attribute normalizing to one of them would
 * overwrite the record's own trace id, severity, body or service there.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'trace_id',
  'span_id',
  'flags',
  'severity',
  'severity_text',
  'severity_number',
  'detected_level',
  'level',
  'observed_timestamp',
  'timestamp',
  '_timestamp',
  'body',
  'scope_name',
  'scope_version',
  'event_name',
  'o2_event_name',
  'instrumentation_library_name',
  'instrumentation_library_version',
  'dropped_attributes_count',
  'service_name',
])
