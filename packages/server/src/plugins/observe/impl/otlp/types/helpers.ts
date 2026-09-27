import type { ObserveDef, ServerDef } from 'server:core'
import type { TraceDef } from 'std:trace'

import type { OtlpDef } from './otlp'

/** The shapes this impl passes around inside itself. */
export namespace Helpers {
  /** One record before grouping: the resource and scope it belongs to. */
  export interface Entry<T> {
    readonly resource: OtlpDef.ResourceAttributes
    readonly scope: TraceDef.InstrumentationScope
    readonly item: T
  }

  export interface ScopeGroup<T> {
    readonly scope: TraceDef.InstrumentationScope
    readonly items: T[]
  }

  /** One OTLP `Resource*` block: the records of one (service.name, service.instance.id), one
   * scope block per instrumentation scope. */
  export interface ResourceGroup<T> {
    readonly resource: OtlpDef.ResourceAttributes
    readonly scopes: ScopeGroup<T>[]
  }

  export interface NumberPoint {
    readonly attributes: TraceDef.Attributes
    readonly start: number
    readonly time: number
    readonly value: number
  }

  export interface HistogramPoint {
    readonly attributes: TraceDef.Attributes
    readonly start: number
    readonly time: number
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
    readonly bucketCounts: readonly number[]
    readonly bounds: readonly number[]
  }

  /** One metric of an export (cumulative temporality). */
  export type Metric =
    | {
        readonly kind: 'histogram'
        readonly name: string
        readonly unit: string
        readonly description: string
        readonly points: readonly HistogramPoint[]
      }
    | {
        readonly kind: 'sum'
        readonly name: string
        readonly unit: string
        readonly description: string
        readonly monotonic: boolean
        readonly points: readonly NumberPoint[]
      }
    | {
        readonly kind: 'gauge'
        readonly name: string
        readonly unit: string
        readonly description: string
        readonly points: readonly NumberPoint[]
      }

  /** Attributes before `undefined` values are dropped. */
  export type MaybeAttributes = Readonly<Record<string, TraceDef.AttrValue | undefined>>

  /** A duration histogram derived from recorded spans: which spans feed it, with which
   * (ALLOWLISTED, low-cardinality) attributes. */
  export interface DurationSource {
    readonly name: string
    readonly description: string
    readonly accepts: (span: TraceDef.SpanData) => boolean
    readonly attributes: (span: TraceDef.SpanData) => MaybeAttributes
  }

  export interface HistogramSeries {
    readonly attributes: TraceDef.Attributes
    count: number
    sum: number
    min: number
    max: number
    readonly buckets: number[]
  }

  export interface SumSeries {
    readonly attributes: TraceDef.Attributes
    value: number
  }

  /** One metric of one resource, its series keyed by their attribute set. */
  export interface Instrument {
    readonly kind: 'histogram' | 'sum'
    readonly name: string
    readonly unit: string
    readonly description: string
    readonly monotonic: boolean
    readonly series: Map<string, HistogramSeries | SumSeries>
  }

  export interface ResourceState {
    readonly resource: OtlpDef.ResourceAttributes
    readonly instruments: Map<string, Instrument>
  }

  /** The metric state derived from the observed events (cumulative since the exporter was
   * made). */
  export interface Meter {
    record(event: ObserveDef.Event): void

    /** The current totals, one entry per (resource, metric); `up` = the resources whose
     * `ozaco.service.up` gauge reads 1 now; `active` = the node's in-flight HTTP requests
     * (`http.server.active_requests`). */
    collect(
      now: number,
      up: readonly OtlpDef.ResourceAttributes[],
      active?: ActiveRequests | undefined,
    ): Entry<Metric>[]
  }

  /** The kernel's live `http.server.active_requests` counts and the resource they belong to
   * (the node's — the edge spans run outside any service). */
  export interface ActiveRequests {
    readonly resource: OtlpDef.ResourceAttributes
    readonly requests: readonly ServerDef.ActiveRequests[]
  }

  /** One delivery target of a signal. */
  export interface Target {
    readonly signal: OtlpDef.Signal
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
    readonly fetch: typeof fetch
    readonly timeoutMs: number
    readonly gzip: boolean
    readonly retry: RetryPolicy
  }

  /** {@link OtlpDef.Retry} with its defaults applied. */
  export interface RetryPolicy {
    readonly attempts: number
    readonly initialMs: number
    readonly maxMs: number
  }

  /** One delivery's attempts and time, and the counters its retries count into. */
  export interface DeliveryBudget {
    readonly attempts: number

    /** epoch ms the whole delivery (every attempt, every wait) must end by. */
    readonly deadline: number
    readonly stats: OtlpDef.SignalStats

    /** hears every HTTP answer, whatever its status: the destination is reachable. */
    readonly onAnswer?: (() => void) | undefined
  }

  /** What one accepted request answered: records refused inside it (`partialSuccess`). */
  export interface Delivery {
    readonly rejected: number
    readonly message: string | null
  }

  /** One HTTP answer, read whole. */
  export interface Reply {
    readonly status: number
    readonly headers: Headers
    readonly body: Uint8Array
  }

  /** The protobuf writer: each call appends one field (tag + value). */
  export interface ProtoWriter {
    /** an unsigned varint (uint32, enum, bool). */
    varint(field: number, value: number): void

    /** a signed `int64` varint (a negative one takes 10 bytes). */
    int64(field: number, value: number): void
    fixed64(field: number, value: bigint): void
    sfixed64(field: number, value: number): void
    fixed32(field: number, value: number): void
    double(field: number, value: number): void
    string(field: number, value: string): void
    bytes(field: number, value: Uint8Array): void

    /** a nested message, built by `build` on a child writer. */
    message(field: number, build: (writer: ProtoWriter) => void): void

    /** a packed `repeated fixed64` / `repeated double`. */
    packedFixed64(field: number, values: readonly number[]): void
    packedDouble(field: number, values: readonly number[]): void
    finish(): Uint8Array
  }

  /** One object of the OTLP/JSON mapping. */
  export type Json = Record<string, unknown>

  /** A stats key (`spans` / `logs` / `metrics`). */
  export type SignalKey = keyof OtlpDef.Stats
}
