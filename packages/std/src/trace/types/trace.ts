import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

/**
 * `std:trace` — span lifecycle, W3C trace-context propagation and failure recording, with no
 * exporter of its own: finished spans (`SpanData`) and log records (`LogData`) go to every
 * installed `Tracer` impl. Everything here is plain data except the handles.
 */
export namespace TraceDef {
  export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

  /** An attribute value as it is stored: a primitive or a homogeneous array of primitives. */
  export type AttrValue =
    | string
    | number
    | boolean
    | readonly string[]
    | readonly number[]
    | readonly boolean[]

  /** Stored attributes (`null` / `undefined` values never make it in). */
  export type Attributes = Readonly<Record<string, AttrValue>>

  /**
   * Attributes as a caller hands them over: anything goes. `null` / `undefined` are dropped,
   * plain objects are flattened to dotted keys (3 levels deep), deeper values and arrays of
   * objects become a capped JSON string, mixed primitive arrays become string arrays, non-finite
   * numbers become the strings `'NaN'` / `'Infinity'` / `'-Infinity'` (so every sink holds the
   * same value).
   */
  export type AttributesInput = Readonly<Record<string, unknown>>

  export interface SpanContext {
    /** 32 lowercase hex characters, never all zero. */
    readonly traceId: string
    /** 16 lowercase hex characters, never all zero. */
    readonly spanId: string
    /** W3C trace flags: `0x01` sampled, `0x02` random trace id; every other bit is zero. */
    readonly flags: number
    /** The W3C `tracestate` carried with the context (validated, members joined by `,`). */
    readonly state?: string
    /** Set on a context that arrived from another process (`extract`, `parseTraceparent`). */
    readonly remote?: boolean
  }

  export interface Link {
    readonly context: SpanContext
    readonly attributes?: Attributes
    /** Attributes the per-link limits dropped (present only when > 0). */
    readonly droppedAttributes?: number
  }

  export interface LinkInput {
    readonly context: SpanContext
    readonly attributes?: AttributesInput | undefined
  }

  export interface SpanEvent {
    readonly name: string
    /** Epoch milliseconds (sub-millisecond fraction), on the local trace's anchored clock. */
    readonly time: number
    readonly attributes?: Attributes
    /** Attributes the per-event limits dropped (present only when > 0). */
    readonly droppedAttributes?: number
  }

  /** Never `ok`: a span is either unset or failed. */
  export interface Status {
    readonly code: 'unset' | 'error'
    readonly message?: string
  }

  /** The instrumentation scope — the library that produced a record. */
  export interface InstrumentationScope {
    readonly name: string
    readonly version?: string
  }

  /** A finished, recorded span — what `Tracer.actions.export` receives. */
  export interface SpanData {
    readonly context: SpanContext
    readonly parent: SpanContext | null
    readonly name: string
    readonly kind: SpanKind
    /** The logical service (resource `service.name`); `null` ⇒ the node's default. */
    readonly service: string | null
    readonly scope: InstrumentationScope
    /** Epoch milliseconds with a sub-millisecond fraction, on the anchored clock. */
    readonly start: number
    readonly end: number
    readonly attributes: Attributes
    readonly droppedAttributes: number
    readonly events: readonly SpanEvent[]
    readonly droppedEvents: number
    readonly links: readonly Link[]
    readonly droppedLinks: number
    readonly status: Status
  }

  /** A log record — an exception, a named event or a bridged logger line (`Tracer.actions.emit`). */
  export interface LogData {
    readonly time: number
    readonly observedTime: number
    /** OTel severity: TRACE 1, DEBUG 5, INFO 9, WARN 13, ERROR 17, FATAL 21. */
    readonly severityNumber: number
    /** Only for logger-bridged records (the source level's name). */
    readonly severityText?: string
    /** Always non-empty. */
    readonly body: string
    readonly eventName?: string
    readonly attributes: Attributes
    readonly droppedAttributes: number
    readonly context: SpanContext | null
    readonly service: string | null
    readonly scope: InstrumentationScope
  }

  /** A log record to emit (`emitLog`); what is left out comes from the active span. */
  export interface LogInput {
    /** The display text; empty ⇒ the event name / severity text. */
    body: string
    severityNumber: number
    /** Only for logger-bridged records (the source level's name). */
    severityText?: string | undefined
    eventName?: string | undefined
    attributes?: AttributesInput | undefined
    /** Default: now on the active span's clock. */
    time?: number | undefined
    /** Default: the active span's scope. */
    scope?: InstrumentationScope | undefined
    /** Default: the active span's context. */
    context?: SpanContext | null | undefined
    /** Default: the active span's service. */
    service?: string | null | undefined
  }

  /** How a span classifies a failure that escapes it. */
  export interface FailureOptions {
    /** The failure's status class (an HTTP-like code); the OUTERMOST span's classifier wins. A
     * thrown / unclassified failure counts as 500. */
    status?: ((failure: Result.Failure<unknown>) => number) | undefined
    /** The span attribute `error.type` for the failure (outermost wins); default: the string tag,
     * else the exception type (`code` / `name` of an `Error`). */
    type?: ((failure: Result.Failure<unknown>) => string) | undefined
    /** The exception log record's event name when the failure ORIGINATES in this span
     * (default `exception`). */
    eventName?: string | undefined
    /** The exception severity when the failure was handled (default 13, WARN); outermost wins. */
    handledSeverity?: number | undefined
  }

  export interface SpanOptions {
    kind?: SpanKind | undefined
    /**
     * The instrumentation scope (the library that produced the span). Without one: the span's
     * service (`service`, else the one it inherits) as the scope name; else its local parent's
     * scope when that is not an ozaco library's (`@ozaco/…`); else `app` — a span the caller's
     * own code opens is never labelled `@ozaco/std`.
     */
    scope?: InstrumentationScope | undefined
    /** The logical service; descendants inherit it. */
    service?: string | undefined
    attributes?: AttributesInput | undefined
    links?: readonly LinkInput[] | undefined
    /** An explicit parent (the span becomes a local root under it); `null` forces a new trace. */
    parent?: SpanContext | null | undefined
    /** The sampling decision of a new trace (default true); `false` on a child opts it out. */
    sampled?: boolean | undefined
    /** No RECORDING parent ⇒ no span at all (the body runs untraced). */
    requireParent?: boolean | undefined
    /** Local roots only: `'errors'` buffers the local trace and exports it only when a failure
     * was recorded or a span failed; `'always'` (default) exports as spans end. */
    record?: 'always' | 'errors' | undefined
    /** Epoch milliseconds (default: now on the anchored clock). */
    startTime?: number | undefined
    failure?: FailureOptions | undefined
  }

  export interface RecordOptions {
    /** Default: 13 (WARN) when `handled`, else 17 (ERROR). */
    severity?: number | undefined
    /** Default: the span's `failure.eventName`, else `exception`. */
    eventName?: string | undefined
    handled?: boolean | undefined
  }

  export interface EventOptions {
    time?: number | undefined
    /** Default 9 (INFO). */
    severity?: number | undefined
    /** The record's display text (default: the event name). */
    body?: string | undefined
  }

  export interface EndOptions {
    /** The span failed with this failure (the hold-until-settled rules apply). */
    failure?: Result.Failure<unknown> | undefined
    /** The span was cut short: `ozaco.cancelled = true`, status unset. */
    cancelled?: boolean | undefined
    /** Epoch milliseconds (default: now on the anchored clock). */
    time?: number | undefined
  }

  export interface MarkOptions {
    /** The other side of a wire recorded it (a decoded reply said so). */
    remote?: boolean | undefined
  }

  export interface SettleOptions {
    /** The status the failure was answered with (an HTTP-like code); wins over the classifiers. */
    status?: number | undefined
  }

  /** What a span body sees. Mutators are no-ops once the span ended or when it is not recording. */
  export interface SpanHandle {
    readonly context: SpanContext
    readonly recording: boolean
    setAttributes(attributes: AttributesInput): void
    setAttribute(key: string, value: unknown): void
    addEvent(name: string, attributes?: AttributesInput, time?: number): void
    addLink(context: SpanContext, attributes?: AttributesInput): void
    setStatus(status: Status): void
    updateName(name: string): void
    /** Record `failure` on THIS span now (once per trace): an `exception` span event + one log record. */
    recordFailure(failure: Result.Failure<unknown>, options?: RecordOptions): Operation<void>
  }

  /** A span whose end is decided by the caller (`startSpan`): streamed bodies, lanes. */
  export interface LiveSpan extends SpanHandle {
    /** Run `body` with this span active (it does NOT end the span). */
    run<T>(body: (span: SpanHandle) => Operation<T>): Operation<T>
    /** End the span; idempotent. */
    end(options?: EndOptions): Operation<void>
  }

  /** The value `ActiveSpan` holds: a recording / non-recording span or a pass-through context. */
  export interface ActiveRecorder {
    readonly context: SpanContext
    readonly recording: boolean
    readonly handle: SpanHandle
  }

  /** Pins id generation (tests); default: `crypto.getRandomValues`. */
  export interface Ids {
    trace(): string
    span(): string
  }

  /** The headers `inject()` produces. */
  export interface Carrier {
    traceparent?: string
    tracestate?: string
  }

  export interface InjectOptions {
    /** Mark the outgoing context as an exporting ozaco caller (`ozaco=1` in `tracestate`) — only
     * when the active span is recording. */
    ozaco?: boolean | undefined
  }

  /** `get(name)` of a header source; an array means several header fields. */
  export type Getter = (name: string) => string | readonly string[] | null | undefined

  export interface RenderOptions {
    /** UTF-8 byte budget (default 16384). */
    maxBytes?: number | undefined
  }

  export interface TracerActions {
    export(span: SpanData): Operation<void>
    emit(log: LogData): Operation<void>
  }

  /**
   * A process-level sink for the log records emitted where NO scope Tracer records — tracing
   * off (or never enabled) there, not suppressed: a Logger line of infrastructure installed
   * outside every observing node, an `event()` / `emitLog` / `recordFailure` there
   * (`registerFallback`). Spans never reach it.
   */
  export interface FallbackSink {
    /** Names the sink (diagnostics: which node claims the process's records). */
    readonly id: string
    /**
     * Receives one record. Runs in the EMITTING scope, suppressed — a sink that needs its own
     * scope's contexts (its Tracers, exporters) enters it with `within(scope, …)`. A failure is
     * dropped: telemetry never fails the code that logged.
     */
    emit(log: LogData): Operation<void>
  }
}
