import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import type { CarrierDef } from './carrier'
import type { ServerDef } from './server'

/** A built observe-store plugin (`ObservePlugin`) — install options are the impl's own, so the
 * argument list stays open. */
export type ObserveDef = Plugin<ObserveDef.Context, AnyType[], ObserveDef.Actions>

/**
 * What the kernel reports and what the observe store answers. The kernel → sink contract is ONE
 * union of two records ({@link Event}): a finished span or a log record, each with the resource
 * it belongs to — every sink (the store, every exporter) receives exactly the same events.
 */
export namespace ObserveDef {
  // --- the kernel → sink contract ----------------------------------------------------------------

  /**
   * The resource a record belongs to: `service.name` (the record's `service` — the ozaco service
   * of the dispatch it ran under in the default `serviceName: 'service'` mode — else the node's
   * name), `service.instance.id` (the node), plus the node-level attributes the kernel holds
   * (`service.namespace`, `service.version`, `deployment.environment.name`, `telemetry.sdk.*`,
   * `ozaco.carrier.name`). Built by `resourceOf(kernel, service)` — one shared object per name.
   */
  export interface Resource {
    readonly 'service.name': string
    readonly 'service.instance.id': string
    readonly [key: string]: TraceDef.AttrValue
  }

  /** One thing the kernel observed: a finished span or a log record (exceptions, events, logs,
   * domain records are all log records). Nothing else is reported. */
  export type Event =
    | { readonly t: 'span'; readonly span: TraceDef.SpanData; readonly resource: Resource }
    | { readonly t: 'log'; readonly log: TraceDef.LogData; readonly resource: Resource }

  /**
   * A DOMAIN record (audit trails, business events) — `Server.actions.report({ stream: 'audit',
   * … })`: ONE log record with `eventName: 'ozaco.local'`, `ozaco.local.stream` and the fields
   * flattened into attributes, correlated to the active span.
   */
  export interface DomainRecord {
    /** the logical stream (`audit`, `billing`, …). */
    readonly stream: string

    /** epoch ms; default: now on the active span's clock. */
    readonly time?: number | undefined
    readonly [field: string]: unknown
  }

  // --- the store -----------------------------------------------------------------------------------
  // `ObservePlugin` keeps exactly the two record kinds, one row each (`_ob2_spans` / `_ob2_logs`),
  // with the resource they belong to — the same data every exporter ships.

  /**
   * One stored span (`_ob2_spans`): the SpanData, its hot fields as columns (what the console
   * filters and sorts on) and the rest as json, plus its resource. `root` marks a LOCAL root —
   * no parent, or a remote one (the trace entered this service here): what the trace list shows.
   */
  export interface SpanRow {
    readonly trace_id: string
    readonly span_id: string
    readonly parent_span_id: string | null
    readonly name: string
    readonly kind: TraceDef.SpanKind

    /** the instrumentation scope name (`@ozaco/server`, `@ozaco/db`, …) and version. */
    readonly scope: string
    readonly scope_version: string | null

    /** the resource: `service.name` / `service.instance.id` (the rest in {@link resource}). */
    readonly service_name: string
    readonly service_instance_id: string

    /** epoch ms (sub-ms fraction kept). */
    readonly start: number
    readonly end: number
    readonly duration_ms: number
    readonly status_code: TraceDef.Status['code']
    readonly status_message: string | null

    /** `error.type` — set on every span a failure escaped (4xx included, status unset). */
    readonly error_type: string | null
    readonly root: boolean

    /** `http.route` / `http.response.status_code` of an HTTP span. */
    readonly http_route: string | null
    readonly http_status: number | null

    /** `ozaco.request.id` — the request id when it is not the trace id (an inbound
     * `x-request-id`, or the fresh id of a request that continued a caller's trace). */
    readonly request_id: string | null

    /** W3C trace flags + tracestate of the span's own context. */
    readonly flags: number
    readonly trace_state: string | null
    readonly attributes: TraceDef.Attributes
    readonly events: readonly TraceDef.SpanEvent[]
    readonly links: readonly TraceDef.Link[]
    readonly dropped_attributes: number
    readonly dropped_events: number
    readonly dropped_links: number

    /** the node-level resource attributes besides the two columns (`service.namespace`, …). */
    readonly resource: Readonly<Record<string, TraceDef.AttrValue>>
  }

  /** One stored log record (`_ob2_logs`): Logger lines, `ctx.log`, exceptions (an exception
   * `event_name`), events, domain records — correlated to their span by `trace_id` / `span_id`. */
  export interface LogRow {
    readonly trace_id: string | null
    readonly span_id: string | null
    readonly flags: number | null

    /** epoch ms (sub-ms fraction kept). */
    readonly time: number
    readonly observed_time: number
    readonly severity_number: number
    readonly severity_text: string | null
    readonly body: string
    readonly event_name: string | null
    readonly service_name: string
    readonly service_instance_id: string
    readonly scope: string
    readonly scope_version: string | null
    readonly attributes: TraceDef.Attributes
    readonly dropped_attributes: number
    readonly resource: Readonly<Record<string, TraceDef.AttrValue>>
  }

  /** One trace as the store holds it: every span (start order, parents first) and every log. */
  export interface TraceView {
    readonly trace_id: string
    readonly spans: readonly SpanRow[]
    readonly logs: readonly LogRow[]
  }

  /** Which ROOT spans `traces()` lists (newest first). Every filter is exact. */
  export interface TracesQuery {
    /** the root span's name (`GET /todos/:id`, `todos.create`). */
    readonly name?: string | undefined

    /** the root span's `http.route`. */
    readonly route?: string | undefined

    /** the root span's `service.name`. */
    readonly service?: string | undefined

    /** `'ok'`: no failure escaped the root; `'failed'`: one did (`error.type` set, a 4xx
     * included); `'error'`: the root's status is error (5xx). */
    readonly status?: 'ok' | 'failed' | 'error' | undefined

    /** the root's `error.type` (`todo.kaput`, `server.validation`, `500`). */
    readonly errorType?: string | undefined

    /** only roots slower than this many ms. */
    readonly slowerThan?: number | undefined

    /** only roots started at/after this epoch ms. */
    readonly since?: number | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }

  /** A page of root spans — one per trace. A trace with several stored roots is listed by the one
   * with no parent, else one whose parent is not stored, else one whose parent is; ties go to the
   * earliest start, then the lower span id. */
  export interface TracesPage {
    readonly traces: readonly SpanRow[]
    readonly cursor: string | null
  }

  export interface Stats {
    /** records queued for the store / dropped on overflow / waiting now. */
    readonly recorded: number
    readonly dropped: number
    readonly pending: number

    /** cluster mode: records forwarded to / received from the collector, written locally as the
     * fallback. */
    readonly forwarded: number
    readonly received: number
    readonly fellBack: number
  }

  export interface Options extends ServerDef.PluginContext {
    readonly store: string
  }

  /** What the install resolves is exactly {@link Options} here. */
  export type Context = Options

  /** One node as the store has seen it lately: its server / client spans and local roots in the
   * window, grouped by `service.instance.id`. */
  export interface InstanceStats {
    readonly instance: string

    /** every `service.name` those spans carried. */
    readonly services: readonly string[]
    readonly spans: number

    /** spans whose status is error. */
    readonly failed: number
    readonly p95_ms: number | null
    readonly last_seen: number
  }

  /** The cluster as observed: presence members per service + per-instance span stats. */
  export interface ClusterView {
    readonly members: Readonly<Record<string, readonly CarrierDef.Member[]>>
    readonly instances: readonly InstanceStats[]

    /** the stats window (epoch ms). */
    readonly since: number
  }

  /** The store's query surface. */
  export interface Actions {
    /** Keep one observed record (what the kernel's `observe` hook does). */
    record(event: Event): Operation<void>

    /** Root spans, newest first — cursor-paged. */
    traces(query?: TracesQuery): Operation<TracesPage>

    /** One trace: its spans + logs; `null` when the store holds nothing of it. */
    trace(traceId: string): Operation<TraceView | null>

    /** The trace a request id belongs to (`ozaco.request.id`, else the id as a trace id). */
    request(id: string): Operation<TraceView | null>

    /** New root spans as they are stored (matching `query`). */
    watch(query?: TracesQuery): Flow<readonly SpanRow[], never>

    /** Delete rows older than `before` (epoch ms); resolves how many went. */
    prune(before: number): Operation<number>
    stats(): Operation<Stats>

    /** Presence members + per-instance stats over the last `windowMs` (default 15 min). */
    cluster(windowMs?: number): Operation<ClusterView>

    /** Write whatever is still queued. */
    flush(): Operation<void>
  }

  // --- exporters -------------------------------------------------------------------------------

  /** What an `ObserveExporter` impl resolves: at least its name. */
  export interface ExporterContext {
    /** `otlp`, `openobserve`, `stdout`, … */
    readonly exporter: string
  }

  /**
   * The exporter contract — a place the kernel's observations are SHIPPED to (an OTLP collector,
   * OpenObserve, stdout). Several run side by side: the kernel fans every event out to all of
   * them (`ObserveExporter` is cloneable; `exec` runs every install, each suppressed), starts them
   * with the node and flushes them at stop. Options are TRANSPORT ONLY — every sink ships the
   * same content. An exporter never fails the thing it observes: deliveries are counted, not
   * raised.
   */
  export interface ExporterActions {
    export(event: Event): Operation<void>
    start(): Operation<void>
    flush(): Operation<void>
  }
}
