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
    requestId: id ?? (yield* requestId()),
    spanId: yield* spanId(),
    origin,
    serviceId,
    lane: [],
  }
}

/** The trace of a child step under `parent` (same request, new span). */
export function* childTrace(
  parent: TraceDef.Trace,
  serviceId = parent.serviceId,
): Operation<TraceDef.Trace> {
  return {
    requestId: parent.requestId,
    spanId: yield* spanId(),
    parentSpanId: parent.spanId,
    origin: parent.origin,
    serviceId,
    lane: parent.lane,
  }
}

/** Continue a trace that arrived over the wire on this node. */
export function* continueTrace(wire: TraceDef.Wire, serviceId: string): Operation<TraceDef.Trace> {
  return {
    requestId: wire.requestId,
    spanId: yield* spanId(),
    parentSpanId: wire.spanId,
    origin: 'external',
    serviceId,
    lane: wire.lane,
  }
}

export const toWire = (trace: TraceDef.Trace): TraceDef.Wire => ({
  requestId: trace.requestId,
  spanId: trace.spanId,
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

    yield* report(kernel, {
      t: 'span',
      row: {
        requestId: trace.requestId,
        spanId: trace.spanId,
        parentSpanId: trace.parentSpanId ?? null,
        kind: input.kind,
        name: input.name,
        serviceId: trace.serviceId,
        instance: kernel.instance,
        actionId: input.actionId ?? null,
        transport: input.transport ?? null,
        startedAt,
        endedAt,
        status,
        attrs: input.attrs ?? null,
      },
    })

    if (failure) {
      const failed = failure as AnyType

      yield* report(kernel, {
        t: 'failure',
        row: {
          requestId: trace.requestId,
          spanId: trace.spanId,
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
