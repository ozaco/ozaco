import type { ObserveDef } from 'server:core'
import type { TraceDef } from 'std:trace'

export namespace OtlpDef {
  /** The OTLP/HTTP payload encoding: binary protobuf (the OTLP default — every backend takes
   * it) or OTLP/JSON. */
  export type Encoding = 'protobuf' | 'json'

  /** The three OTLP signals, each POSTed to `{url}/v1/{signal}`. */
  export type Signal = 'traces' | 'logs' | 'metrics'

  export type SpanEvent = Extract<ObserveDef.Event, { readonly t: 'span' }>
  export type LogEvent = Extract<ObserveDef.Event, { readonly t: 'log' }>

  /** Resource attributes (the event's resource — the kernel's, `OTEL_RESOURCE_ATTRIBUTES`
   * included). */
  export type ResourceAttributes = Readonly<Record<string, TraceDef.AttrValue>>

  /**
   * Retries of a failed delivery: 429 / 502 / 503 / 504 and network errors (timeouts included)
   * are retried with exponential backoff (×1.5, ±20% jitter, a `Retry-After` answer wins — capped
   * at 30 s); any other status is final. Once a delivery failed for good, the signal's next ones
   * get a single attempt until the destination answers again — and once the destination answered
   * NOTHING (refused, unresolvable, timed out), so does every other signal's (a known-down backend
   * never stalls the beat or the stop).
   */
  export interface Retry {
    /** attempts in total, the first included. Default 5. */
    readonly attempts?: number | undefined

    /** the first backoff. Default 1000 ms. */
    readonly initialMs?: number | undefined

    /** the longest backoff. Default 5000 ms. */
    readonly maxMs?: number | undefined
  }

  export interface Batch {
    /** records per request — a full batch leaves at once. Default 200. */
    readonly size?: number | undefined

    /** longest a record waits for its batch. Default 1000 ms. */
    readonly waitMs?: number | undefined

    /** records held per signal before the oldest are dropped (counted). Default 10 000. */
    readonly maxPending?: number | undefined
  }

  /**
   * Exporter options are TRANSPORT ONLY: where and how the records travel. WHAT is exported is
   * fixed by the kernel — every sink (the store, stdout, OTLP, OpenObserve, your own) receives the
   * same spans and log records, and the metrics derived from them are fixed too.
   */
  export interface Options {
    /** The OTLP/HTTP base url (`http://localhost:4318`); `/v1/{traces,logs,metrics}` is
     * appended. */
    readonly url: string

    /** extra request headers (auth, tenant). */
    readonly headers?: Readonly<Record<string, string>> | undefined

    /** extra headers of ONE signal's requests (OpenObserve's `stream-name`). */
    readonly signalHeaders?:
      | Readonly<Partial<Record<Signal, Readonly<Record<string, string>>>>>
      | undefined

    /** Default `'protobuf'` (`application/x-protobuf`). `'json'` sends OTLP/JSON — keys verbatim,
     * ids hex, 64-bit integers as strings. */
    readonly encoding?: Encoding | undefined

    /** gzip every request body (`content-encoding: gzip`). Default false. */
    readonly gzip?: boolean | undefined

    /** How long ONE batch's delivery may take — every attempt and every backoff between them
     * (like the OTel JS exporters): each attempt gets what is left (its fetch is aborted when it
     * runs out) and a retry that would start past it is not made. The stop-time flush as a
     * whole gets this long too, so a node stops in about `timeoutMs` even against a collector
     * that never answers. Default 10 000 ms. */
    readonly timeoutMs?: number | undefined

    /** `false` sends each request once. Default: 5 attempts. */
    readonly retry?: false | Retry | undefined

    readonly batch?: Batch | undefined

    /** the metrics derived from the recorded spans (`http.server.request.duration`, …) are
     * POSTed every `intervalMs` (default 10 000) and at stop; `false` sends none. */
    readonly metrics?: false | { readonly intervalMs?: number | undefined } | undefined

    /** `fetch` to use (tests). */
    readonly fetch?: typeof fetch | undefined
  }

  /** Delivery counters of one signal. */
  export interface SignalStats {
    /** records (spans, log records) or metric EXPORTS delivered. */
    sent: number

    /** records dropped before a send (`maxPending` overflow). */
    dropped: number

    /** records (or metric exports) whose delivery failed for good. */
    failed: number

    /** records the backend refused inside an accepted request (`partialSuccess`). */
    rejected: number

    /** retries made (each re-send counts once). */
    retried: number

    /** the last delivery problem (`partialSuccess.errorMessage` or the failure), else null. */
    lastError: string | null
  }

  export interface Stats {
    readonly spans: SignalStats
    readonly logs: SignalStats
    readonly metrics: SignalStats
  }

  /** One OTLP destination's pipeline (`createOtlpPipeline`): sinks, encoder, transport, meter. */
  export interface Pipeline {
    /** the base url (`/v1/{signal}` is appended). */
    readonly url: string
    readonly encoding: Encoding

    /** the exporter's export / start / flush over the pipeline's sinks and metrics beat. */
    readonly handle: ObserveDef.ExporterActions
    readonly stats: () => Stats
  }

  export interface Context extends ObserveDef.ExporterContext, Pipeline {}

  export interface EncodeOptions {
    /** Default `'protobuf'`. */
    readonly encoding?: Encoding | undefined

    /** attributes UNDER every event's resource (the event's own win). The exporters pass none:
     * the kernel's resource already carries the process's `OTEL_RESOURCE_ATTRIBUTES`, so every
     * sink holds the same set. */
    readonly resource?: ResourceAttributes | undefined
  }

  /** One encoded OTLP export request. */
  export interface Encoded {
    readonly body: Uint8Array | string
    readonly contentType: string

    /** how many records (spans, log records, metric data points) it carries. */
    readonly items: number
  }
}
