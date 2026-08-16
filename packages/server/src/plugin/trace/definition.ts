// oxlint-disable import/exports-last
import type { SpanContext, TracerDef } from 'server:core'
import { CoreErrors, TraceExporter, Tracer, definePolicy, laneOf } from 'server:core'
import { moduleLogger, randomHex } from 'server:utils'
import { attempt, createSignal, ensure, fork, operation, race, sleep } from 'std:effect'
import { isFailure } from 'std:result'

import { TRACE_BATCH_SIZE, TRACE_FLUSH_INTERVAL_MS, TRACE_KEEP, TRACING_PRIORITY } from './const'
import type { TracingState } from './internal'
import { createSpan, flushSnapshots, formatTraceparent, parseTraceparent } from './internal'
import type {
  MemoryExporterContext,
  TracerContext,
  TracerOptions,
  TracingPolicyOptions,
} from './types'

const DefaultTracerImpl = Tracer.implement<TracerContext, [options?: TracerOptions]>({
  name: 'default-tracer',
  version: '0.1.0',
  description: 'Span factory with a scope-bound batcher pumping snapshots to the TraceExporter',

  *setup(options) {
    const ctx: TracerContext = {
      flushIntervalMs: Math.max(1, options?.flushIntervalMs ?? TRACE_FLUSH_INTERVAL_MS),
      batchSize: Math.max(1, options?.batchSize ?? TRACE_BATCH_SIZE),
      keep: Math.max(0, options?.keep ?? TRACE_KEEP),
      buffer: [],
      recent: [],
      wake: createSignal<void, never>(),
      log: yield* moduleLogger('server:trace'),
    }

    // Subscribe HERE, before any span can `end()` — a signal send with no subscriber is dropped,
    // while sends into the live subscription (even mid-flush) stay queued until the pump pulls.
    const wakes = yield* ctx.wake

    // The pump: flush on cadence, or immediately when `end()` reports a full batch. Exports are
    // attempted inside `flushSnapshots` — a dead collector is logged, never raised.
    yield* fork(function* () {
      while (true) {
        yield* race([sleep(ctx.flushIntervalMs), wakes.next()])
        yield* flushSnapshots(ctx)
      }
    })

    // Final drain at scope teardown so short-lived scopes don't lose their tail spans.
    yield* ensure(() => flushSnapshots(ctx))

    return ctx
  },
})

/**
 * The default `Tracer` implementation. `startSpan` mints OTel-shaped ids (32-hex traceId, 16-hex
 * spanId — inheriting `options.parent` linkage) and returns a mutable span whose `end()` delivers
 * a snapshot into the scope-bound buffer; a forked pump forwards batches to
 * `TraceExporter.actions.export` every `flushIntervalMs` or as soon as `batchSize` is buffered.
 * No exporter installed means the no-op defaults — tracing stays zero-cost. Requires an installed
 * IO implementation (ids).
 *
 * Extra actions: `flush()` (drain now) and `recent()` (the `keep`-sized inspection ring).
 */
export const DefaultTracer = DefaultTracerImpl.build({
  startSpan: operation(function* (name: string, options?: TracerDef.SpanOptions) {
    const ctx = yield* DefaultTracerImpl.context.expect()
    const context: SpanContext = {
      traceId: options?.parent?.traceId ?? (yield* randomHex(16)),
      spanId: yield* randomHex(8),
      parentSpanId: options?.parent?.spanId,
    }

    return createSpan({ tracer: ctx, name, context, options })
  }),

  /** Parse a W3C `traceparent` header — strict per spec, `undefined` for anything malformed. */
  parseTraceparent: operation(function* (header: string) {
    return parseTraceparent(header)
  }),

  /** Render `context` as an outbound W3C `traceparent` header (version 00, sampled flags). */
  formatTraceparent: operation(function* (context: SpanContext) {
    return formatTraceparent(context)
  }),

  /** Drain buffered snapshots to the exporter now, then forward the exporter's own `flush`. */
  flush: operation(function* () {
    const ctx = yield* DefaultTracerImpl.context.expect()

    yield* flushSnapshots(ctx)

    const outcome = yield* attempt(() => TraceExporter.actions.flush())

    if (isFailure(outcome)) {
      yield* ctx.log.warn('exporter flush failed', { error: String(outcome.error) })
    }
  }),

  /** The inspection ring: the most recent `keep` snapshots, oldest first. */
  recent: operation(function* () {
    const ctx = yield* DefaultTracerImpl.context.expect()
    const snapshots: readonly TracerDef.SpanSnapshot[] = [...ctx.recent]

    return snapshots
  }),
})

/**
 * The observer layer (priority 55 — inside metrics, outside timeout): wraps every dispatch in a
 * CLIENT span named `service.action` carrying the full correlation spine as attributes. Failures —
 * raised or folded into a `failure` reply — mark the span `error` and record the exception; the
 * span ALWAYS ends. With no tracer installed the first dispatch caches the `Unsupported` probe and
 * every later dispatch passes through with zero overhead.
 */
export const TracingPolicy = definePolicy<TracingPolicyOptions | void, TracingState>({
  name: 'tracing',
  priority: TRACING_PRIORITY,

  *setup() {
    const state: TracingState = { available: undefined }

    return state
  },

  *apply({ ctx, state, next }) {
    if (state.available === false) {
      return yield* next()
    }

    const { trace, request } = ctx
    const started = yield* attempt(() =>
      Tracer.actions.startSpan(`${request.service}.${request.action}`, {
        kind: 'client',
        attributes: {
          'ozaco.request_id': trace.requestId,
          'ozaco.service_id': trace.serviceId,
          'ozaco.action_id': trace.actionId,
          'ozaco.lane': laneOf(trace),
          'rpc.system': 'ozaco-broker',
          'rpc.service': request.service,
          'rpc.method': request.action,
        },
      }),
    )

    if (isFailure(started)) {
      if (String(started.error) === CoreErrors.Unsupported) {
        state.available = false
      }

      return yield* next()
    }

    state.available = true

    const span = started.value
    const outcome = yield* attempt(() => next())

    if (isFailure(outcome)) {
      span.recordException(outcome.message)
      span.setStatus('error', outcome.message)
      span.end()

      return yield* outcome
    }

    const reply = outcome.value

    if (reply.kind === 'failure') {
      span.recordException(reply.failure.message)
      span.setStatus('error', reply.failure.message)
    }

    span.end()

    return reply
  },
})

const MemoryExporterImpl = TraceExporter.implement<MemoryExporterContext, []>({
  name: 'memory-exporter',
  version: '0.1.0',
  description: 'Collects exported span snapshots in scope-bound memory for tests and inspection',

  *setup() {
    const ctx: MemoryExporterContext = { spans: [] }

    return ctx
  },
})

/**
 * A `TraceExporter` collecting every exported snapshot in its scope-bound context. The extra
 * `drain()` action takes (and clears) everything collected so far — for tests and local
 * inspection.
 */
export const MemoryExporter = MemoryExporterImpl.build({
  *export(spans: readonly TracerDef.SpanSnapshot[]) {
    const ctx = yield* MemoryExporterImpl.context.expect()

    ctx.spans.push(...spans)
  },

  flush: operation(function* () {
    // nothing buffered here — collection is synchronous
  }),

  /** Take every collected snapshot, leaving the collector empty. */
  drain: operation(function* () {
    const ctx = yield* MemoryExporterImpl.context.expect()
    const snapshots: readonly TracerDef.SpanSnapshot[] = ctx.spans.splice(0)

    return snapshots
  }),
})
