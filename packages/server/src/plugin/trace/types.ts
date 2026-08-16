import type { TracerDef } from 'server:core'
import type { BoundLogger } from 'server:utils'
import type { Signal } from 'std:effect'

/** Install-time options for `DefaultTracer`. */
export interface TracerOptions {
  /** Cadence (ms) of the forked pump that flushes buffered snapshots to the exporter. */
  readonly flushIntervalMs?: number | undefined
  /** Buffered snapshot count that wakes the pump for an immediate flush. */
  readonly batchSize?: number | undefined
  /** Capacity of the inspection ring served by `DefaultTracer.actions.recent()`. */
  readonly keep?: number | undefined
}

/**
 * The tracer's scope-bound state: the export buffer, the inspection ring and the pump wake signal.
 * Created per install — there is deliberately no module-global state.
 */
export interface TracerContext {
  readonly flushIntervalMs: number
  readonly batchSize: number
  readonly keep: number
  readonly buffer: TracerDef.SpanSnapshot[]
  readonly recent: TracerDef.SpanSnapshot[]
  readonly wake: Signal<void, never>
  readonly log: BoundLogger
}

/** Scope-bound state of `MemoryExporter`: every exported snapshot until `drain()` takes them. */
export interface MemoryExporterContext {
  readonly spans: TracerDef.SpanSnapshot[]
}

/** Options for `TracingPolicy` (reserved: tracer selection when several tracers exist). */
export interface TracingPolicyOptions {
  readonly tracer?: 'default' | undefined
}
