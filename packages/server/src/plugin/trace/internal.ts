import { TraceExporter } from 'server:core'
import type { Span, SpanContext, TracerDef } from 'server:core'
import { attempt } from 'std:effect'
import type { Operation } from 'std:effect'
import { isFailure } from 'std:result'

import { STATUS_DESCRIPTION_ATTRIBUTE } from './const'
import type { TracerContext } from './types'

/** W3C `traceparent`, version 00: `00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>`. */
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u

const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)

/** Record `snapshot` into the inspection ring, trimming the oldest entries to the capacity. */
const remember = (tracer: TracerContext, snapshot: TracerDef.SpanSnapshot): void => {
  tracer.recent.push(snapshot)

  if (tracer.recent.length > tracer.keep) {
    tracer.recent.splice(0, tracer.recent.length - tracer.keep)
  }
}

/**
 * Mutable per-install `TracingPolicy` state: the cached tracer availability probe. `undefined`
 * until the first dispatch answered it; `false` pins the zero-overhead passthrough path.
 */
export interface TracingState {
  available: boolean | undefined
}

/**
 * Parse a W3C `traceparent` header into the remote {@link SpanContext} local spans should parent
 * under. Strict per spec: version `00` only, lowercase hex only, all-zero ids are invalid.
 * Returns `undefined` for anything malformed.
 */
export const parseTraceparent = (header: string): SpanContext | undefined => {
  const match = TRACEPARENT_PATTERN.exec(header)

  if (!match) {
    return undefined
  }

  const traceId = match[1]!
  const spanId = match[2]!

  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return undefined
  }

  return { traceId, spanId }
}

/** Render `context` as an outbound W3C `traceparent` header (version 00, sampled flags). */
export const formatTraceparent = (context: SpanContext): string =>
  `00-${context.traceId}-${context.spanId}-01`

/**
 * A mutable span. `end()` folds the accumulated state into an immutable {@link TracerDef.SpanSnapshot},
 * delivers it to the tracer's scope-bound buffer + ring, and wakes the pump when a full batch is
 * ready. Repeated `end()` calls are ignored.
 */
export const createSpan = (input: {
  readonly tracer: TracerContext
  readonly name: string
  readonly context: SpanContext
  readonly options?: TracerDef.SpanOptions | undefined
}): Span => {
  const { tracer, name, context, options } = input
  const startMs = Date.now()
  const attributes: Record<string, string | number | boolean> = { ...options?.attributes }
  const events: { readonly ts: number; readonly message: string }[] = []
  let status: 'ok' | 'error' = 'ok'
  let ended = false

  return {
    context,
    setAttribute(key, value) {
      attributes[key] = value
    },
    recordException(message) {
      events.push({ ts: Date.now(), message })
    },
    setStatus(nextStatus, message) {
      status = nextStatus

      if (message !== undefined) {
        attributes[STATUS_DESCRIPTION_ATTRIBUTE] = message
      }
    },
    end() {
      if (ended) {
        return
      }

      ended = true

      const snapshot: TracerDef.SpanSnapshot = {
        name,
        kind: options?.kind ?? 'internal',
        context,
        startMs,
        endMs: Date.now(),
        status,
        attributes: { ...attributes },
        events: [...events],
      }

      tracer.buffer.push(snapshot)
      remember(tracer, snapshot)

      if (tracer.buffer.length >= tracer.batchSize) {
        tracer.wake.send()
      }
    },
  }
}

/**
 * Drain the buffer and attempt one `TraceExporter.actions.export` — an exporter failure (e.g. a
 * dead OTLP collector) is logged and swallowed so tracing can never break the app. With no
 * exporter installed the dispatch hits the protocol's no-op defaults (the zero-cost path).
 */
export function* flushSnapshots(tracer: TracerContext): Operation<void> {
  if (tracer.buffer.length === 0) {
    return
  }

  const batch: readonly TracerDef.SpanSnapshot[] = tracer.buffer.splice(0)
  const outcome = yield* attempt(() => TraceExporter.actions.export(batch))

  if (isFailure(outcome)) {
    yield* tracer.log.warn('span export failed; batch dropped', {
      spans: batch.length,
      error: String(outcome.error),
    })
  }
}
