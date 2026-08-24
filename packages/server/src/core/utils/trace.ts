import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { TraceRef } from '../context'
import type { Helpers } from '../types/helpers'
import type { ObserveDef } from '../types/observe'
import type { ServerDef } from '../types/server'
import type { TraceDef } from '../types/trace'

/** Short, URL-safe span ids (16 hex chars) and UUID request ids — minted through the installed
 * IO (so a platform without `crypto`, or a test that pins ids, stays in charge). */
export function* spanId(): Operation<string> {
  return (yield* IO.actions.uuid()).replaceAll('-', '').slice(0, 16)
}

export function* requestId(): Operation<string> {
  return yield* IO.actions.uuid()
}

/** A fresh trace for a request entering here. */
export function* rootTrace(
  serviceId: string,
  origin: TraceDef.Origin,
  id?: string,
): Operation<TraceDef.Trace> {
  return {
    request_id: id ?? (yield* requestId()),
    span_id: yield* spanId(),
    origin,
    service_id: serviceId,
    lane: [],
  }
}

/** The trace of a child step under `parent` (same request, new span). */
export function* childTrace(
  parent: TraceDef.Trace,
  serviceId = parent.service_id,
): Operation<TraceDef.Trace> {
  return {
    request_id: parent.request_id,
    span_id: yield* spanId(),
    parentSpanId: parent.span_id,
    origin: parent.origin,
    service_id: serviceId,
    lane: parent.lane,
  }
}

/** Continue a trace that arrived over the wire on this node. */
export function* continueTrace(wire: TraceDef.Wire, serviceId: string): Operation<TraceDef.Trace> {
  return {
    request_id: wire.request_id,
    span_id: yield* spanId(),
    parentSpanId: wire.span_id,
    origin: 'external',
    service_id: serviceId,
    lane: wire.lane,
  }
}

export const toWire = (trace: TraceDef.Trace): TraceDef.Wire => ({
  request_id: trace.request_id,
  span_id: trace.span_id,
  parentSpanId: trace.parentSpanId,
  lane: trace.lane,
})

/** Hand one observed event to every observing hook and the kernel's event stream. */
export function* report(kernel: ServerDef.Context, event: ObserveDef.Event): Operation<void> {
  kernel.events.emit('observe', event)

  for (const hooks of kernel.hooks) {
    if (hooks.observe) {
      // an observer must never fail the thing it observes
      yield* attempt(() => hooks.observe!(event))
    }
  }
}

/**
 * Run `body` as one span: `TraceRef` is set to the span's trace for its extent; the span row is
 * reported when it ends — `ok`, `failed` (with a failure row) or `cancelled` (a halt).
 */
export function* withSpan<T>(input: Helpers.SpanInput, body: () => Operation<T>): Operation<T> {
  const { kernel, trace } = input
  const startedAt = Date.now()
  let status: TraceDef.SpanStatus = 'cancelled'
  let failure: unknown = null

  try {
    const outcome = yield* TraceRef.with(trace, () => attempt(body))

    if (isFailure(outcome)) {
      status = 'failed'
      failure = outcome

      return yield* outcome
    }

    status = 'ok'

    return outcome.value
  } finally {
    const endedAt = Date.now()

    // a failed span carries WHAT failed — exporters surface it as the span's error content
    const failedAttrs = failure
      ? {
          error: String((failure as AnyType).error),
          'error.message': String((failure as AnyType).message ?? ''),
        }
      : null

    yield* report(kernel, {
      t: 'span',
      row: {
        request_id: trace.request_id,
        span_id: trace.span_id,
        parent_span_id: trace.parentSpanId ?? null,
        kind: input.kind,
        name: input.name,
        service_id: trace.service_id,
        instance: kernel.instance,
        action_id: input.actionId ?? null,
        transport: input.transport ?? null,
        started_at: startedAt,
        ended_at: endedAt,
        status,
        attrs: input.attrs || failedAttrs ? { ...input.attrs, ...failedAttrs } : null,
      },
    })

    if (failure) {
      const failed = failure as AnyType

      yield* report(kernel, {
        t: 'failure',
        row: {
          request_id: trace.request_id,
          span_id: trace.span_id,
          tag: String(failed.error),
          message: String(failed.message ?? ''),
          causes: [...(failed.causes ?? [])],
          status: null,
          where: `${input.kind}:${input.name}`,
          ts: endedAt,
        },
      })
    }
  }
}
