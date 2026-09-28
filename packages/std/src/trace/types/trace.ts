import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

/**
 * `std:trace` — span lifecycle, W3C trace-context propagation and failure recording, with no
 * exporter of its own: finished spans (`SpanData`) and log records (`LogData`) go to every
 * installed `Trace` impl. Everything here is plain data except the handles.
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
    /** Set on a context that arrived from another process (`extract`). */
    readonly remote?: boolean
    /** Set by `extract` when the sender marked itself an exporting ozaco caller (`ozaco=1` in
     * `tracestate`, what `inject({ ozaco: true })` writes). */
    readonly ozaco?: boolean
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

  /** A finished, recorded span — what a sink's `export` receives. */
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

  /** A log record — an exception, a named event or a bridged logger line (a sink's `emit`). */
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

  /** A log record to emit (`Trace.actions.emitLog`); what is left out comes from the active span. */
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
    /**
     * The failure the line reports. At WARN+ inside a RECORDING span it is recorded there
     * (`recordFailure`, once per trace) and the line carries no exception attributes; elsewhere the
     * line carries them (unless the failure has an exception record in the line's trace already)
     * and, at WARN+, the failure is marked recorded in that trace. An attribute of the line's own
     * that an exception attribute takes moves to `ozaco.data.<key>`.
     */
    failure?: Result.Failure<unknown> | undefined
    /** No line when this call recorded `failure` on the span: the line would only repeat it. */
    omitRecorded?: boolean | undefined
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
    /** Whether `context` carries valid W3C ids — `false` for the no-op handle (no span here). */
    readonly valid: boolean
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

  /** A span whose end is decided by the caller (`Trace.actions.startSpan`): streamed bodies, lanes. */
  export interface LiveSpan extends SpanHandle {
    /** Run `body` with this span active (it does NOT end the span). */
    run<T>(body: (span: SpanHandle) => Operation<T>): Operation<T>
    /** End the span; idempotent. */
    end(options?: EndOptions): Operation<void>
  }

  /** The value the active-span context holds: a recording / non-recording span or a pass-through context. */
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
    /** The context to write (default: the active one — a recording or non-recording span, or a
     * pass-through inbound context). */
    context?: SpanContext | undefined
    /** Mark the outgoing context as an exporting ozaco caller (`ozaco=1` in `tracestate`) — only
     * when the active span is recording. */
    ozaco?: boolean | undefined
  }

  /** `get(name)` of a header source; an array means several header fields. */
  export type Getter = (name: string) => string | readonly string[] | null | undefined

  export interface AttributeOptions {
    /** UTF-8 bytes per string value (default 2048). */
    maxBytes?: number | undefined
    /** Keys kept (default 128); the rest are counted as dropped. */
    maxCount?: number | undefined
  }

  /** Whether spans are recorded in a scope: flipping `enabled` is seen by every fork of it. */
  export interface TracingState {
    enabled: boolean
  }

  /** A span body. */
  export type Body<T> = (span: SpanHandle) => Operation<T>

  /** What a `Trace` impl (a sink) implements. */
  export interface SinkActions {
    /** Receives one finished, recorded span. */
    export(span: SpanData): Operation<void>
    /** Receives one log record. */
    emit(log: LogData): Operation<void>
  }

  /** `Trace.actions.*`: protocol-level, they run once whatever is installed. */
  export interface Handlers {
    /**
     * Run `body` in a span. Tracing off / suppressed (or `requireParent` without a recording
     * parent): the body runs with the current handle, no ids are minted. Otherwise the span is
     * active for the body (every fork of it shares the one recorder) and ends with its outcome: a
     * failure raised — or RETURNED — by the body fails it (held until it settles, see `settle`), a
     * halt marks it `ozaco.cancelled`. A returned Result is unwrapped by the plugin runtime: wrap
     * the call in `attempt` to get it back as a value.
     */
    span<T>(name: string, body: Body<T>): Operation<T>
    span<T>(name: string, options: SpanOptions, body: Body<T>): Operation<T>
    /**
     * Start a span whose end the caller decides — a streamed body, a lane: `live.run(body)` runs
     * code with it active, `live.end({ failure?, cancelled?, time? })` ends it (idempotent).
     * Tracing off ⇒ an idle span: `run` just runs the body, `end` does nothing.
     */
    startSpan(name: string, options?: SpanOptions): Operation<LiveSpan>
    /** The active span's handle; a no-op handle when there is none (or telemetry is suppressed). */
    current(): Operation<SpanHandle>
    /** The active span's context — recording, non-recording or pass-through (also under
     * suppression, for log correlation), its `tracestate` included; `null` when there is none. */
    activeContext(): Operation<SpanContext | null>
    /**
     * Run `body` with `context` (an inbound one this node only forwards) as the active context:
     * carried UNCHANGED while tracing is off — `inject()` forwards it as received — and continued
     * as a local root by a span opened under it while tracing is on. An invalid context (ids no
     * W3C header can carry) is ignored: the body runs as it would without one.
     */
    passThrough<T>(context: SpanContext, body: () => Operation<T>): Operation<T>
    /** Run `body` with NO active span: what it opens starts new traces, `inject()` sends nothing. */
    detached<T>(body: () => Operation<T>): Operation<T>
    /**
     * Make `target` the active span of the CURRENT scope from here on — a live span (its recorder,
     * or what is active inside it when it records nothing), an inbound context (as a pass-through),
     * `null` (none) or `undefined` (left as is) — for code that cannot wrap a body (a socket
     * handler between frames); an invalid context is ignored (left as is). Returns the restore:
     * the scope's previous state back; never fails.
     */
    activate(target: LiveSpan | SpanContext | null | undefined): Operation<() => void>
    /**
     * A named event: a span event on the active span (when it records) AND a log record with
     * `eventName = name` (while tracing is on). Severity default 9 (INFO), body default the name.
     * Tracing off: the record alone goes to the process fallback sink, when one is registered.
     */
    event(name: string, attributes?: AttributesInput, options?: EventOptions): Operation<void>
    /**
     * Emit a log record correlated to the active span: what `input` leaves out (context, service,
     * scope, time) comes from it. Suppressed: a no-op. Tracing off: the record goes to the process
     * fallback sink, when one is registered, else nowhere.
     */
    emitLog(input: LogInput): Operation<void>
    /**
     * Record `failure` on the ACTIVE span now — once per (failure, trace): an `exception` span
     * event when the span records, and one exception log record. Severity: `options.severity`,
     * else 13 (WARN) when `handled`, else 17 (ERROR).
     */
    recordFailure(failure: Result.Failure<unknown>, options?: RecordOptions): Operation<void>
    /**
     * The failure was ANSWERED with `status` (the edge or a carrier encoded it into a reply):
     * settle it now instead of when an ancestor ends. Call it BEFORE the answering span ends.
     */
    settle(failure: Result.Failure<unknown>, options?: SettleOptions): Operation<void>
    /** Mark `failure` recorded in trace `traceId` (another party recorded it); `remote` — the
     * sender of a decoded reply recorded it: the spans it escapes here get `ozaco.failure.remote`. */
    markRecorded(
      failure: Result.Failure<unknown>,
      traceId: string,
      options?: MarkOptions,
    ): Operation<void>
    /** Whether `failure` was recorded in trace `traceId` — by any std copy in this process. */
    isRecorded(failure: Result.Failure<unknown>, traceId: string): Operation<boolean>
    /**
     * The W3C headers for an outgoing call: `options.context`, else the active context; `{}`
     * without one or when its ids are invalid. Suppressed code sends it unsampled. `{ ozaco: true }` marks a recording span's
     * context as an exporting ozaco caller (`ozaco=1`, leftmost in `tracestate`).
     */
    inject(options?: InjectOptions): Operation<Carrier>
    /**
     * The inbound W3C context of `source` — a header getter (`name => headers.get(name)`) or a
     * carrier (`{ traceparent, tracestate }`) — or `null` when there is none or it is invalid.
     * An invalid `tracestate` is dropped, not the context. Never fails.
     */
    extract(source: Getter | Carrier): Operation<SpanContext | null>
    /**
     * Run `body` with telemetry SUPPRESSED: no spans, no span events, no log records (the active
     * span stays for propagation, which sends it unsampled). Every sink call runs this way.
     */
    suppressed<T>(body: () => Operation<T>): Operation<T>
    /**
     * Turn tracing on (or off) for the CURRENT scope: its own state (created when it has none —
     * a parent's is never flipped), returned so the caller can flip it later. An impl calls it
     * in `setup`.
     */
    enableTracing(enabled?: boolean): Operation<TracingState>
    /** Whether spans would be recorded here: tracing on and not suppressed. */
    isTracing(): Operation<boolean>
    /** Whether telemetry is suppressed here (`suppressed`). */
    isSuppressed(): Operation<boolean>
    /** Whether a log record emitted here goes anywhere: tracing on (not suppressed), or tracing
     * off and a fallback sink registered. */
    canEmit(): Operation<boolean>
    /** Now on the active local trace's clock (epoch ms, sub-millisecond), else on the clock a new
     * local root anchors to. */
    traceNow(): Operation<number>
    /** A fresh W3C trace id (32 lowercase hex, never all zero). */
    newTraceId(): Operation<string>
    /** A fresh W3C span id (16 lowercase hex, never all zero). */
    newSpanId(): Operation<string>
    /** Pin trace / span id generation in the CURRENT scope (tests); default random. */
    useIds(ids: Ids): Operation<void>
    /**
     * Register a PROCESS-LEVEL fallback for the log records emitted where no scope sink records
     * (tracing off there, not suppressed). The FIRST registered sink receives; later ones queue
     * behind it. Shared by every std copy in the process. Returns the unregister function.
     */
    registerFallback(sink: FallbackSink): Operation<() => void>
    /**
     * Attributes in their stored form: `null` / `undefined` dropped, plain objects flattened to
     * dotted keys (3 levels), arrays of objects a JSON string, mixed primitive arrays string
     * arrays, non-finite numbers their strings. `dropped` counts the keys past `maxCount`.
     */
    toAttributes(
      input: AttributesInput | undefined,
      options?: AttributeOptions,
    ): Operation<{ attributes: Attributes; dropped: number }>
  }

  /**
   * A process-level sink for the log records emitted where NO scope sink records — tracing
   * off (or never enabled) there, not suppressed: a Logger line of infrastructure installed
   * outside every observing node, an `event` / `emitLog` / `recordFailure` there
   * (`Trace.actions.registerFallback`). Spans never reach it.
   */
  export interface FallbackSink {
    /** Names the sink (diagnostics: which node claims the process's records). */
    readonly id: string
    /**
     * Receives one record. Runs in the EMITTING scope, suppressed — a sink that needs its own
     * scope's contexts (its sinks, exporters) enters it with `within(scope, …)`. A failure is
     * dropped: telemetry never fails the code that logged.
     */
    emit(log: LogData): Operation<void>
  }
}
