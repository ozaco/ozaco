import { attempt } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { defineProtocol } from 'std:plugin'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import pkg from '../../package.json'

import { TraceErrors } from './errors'
import { TRACE } from './internal/const'
import {
  activate,
  activeContext,
  activeSpan,
  canEmit,
  current,
  detached,
  emitLog,
  enableTracing,
  event,
  extract,
  inject,
  isRecorded,
  isSuppressedHere,
  isTracing,
  markRecorded,
  newSpanId,
  newTraceId,
  passThrough,
  recordedBy,
  recordFailure,
  registerFallback,
  settle,
  span,
  startSpan,
  suppressed,
  toAttributes,
  traceNow,
  useIds,
} from './internal/handlers'
import type { TraceDef } from './types/trace'

/**
 * Span lifecycle, W3C propagation and failure recording — every feature is a `Trace.actions.*`
 * handler (they run once, whatever is installed). Where finished spans and log records go is
 * the impls': CLONEABLE, every `export` / `emit` fans out to EVERY install in install order (an
 * in-memory test sink next to the server's). Defaults are no-ops, so a scope without an install
 * drops everything. An impl's `setup` turns tracing on for its scope with
 * `Trace.actions.enableTracing()`; one install failing never stops the others (the first failure
 * is raised after all ran, tagged `TraceErrors.Tracer`) — traced code never sees a sink failure.
 * The plugin runtime appends no location labels to failures passing this protocol.
 */
export const Trace: Protocol<unknown, TraceDef.SinkActions, TraceDef.Handlers> = defineProtocol<
  unknown,
  TraceDef.SinkActions,
  TraceDef.Handlers
>({
  name: 'std/trace',
  version: pkg.version,
  description: 'Spans, log records and W3C propagation; impls receive the finished data',

  subtype: TRACE,
  cloneable: true,
  labels: false,

  handlers: {
    span: span as TraceDef.Handlers['span'],
    startSpan,
    current,
    active: activeSpan,
    activeContext,
    passThrough,
    detached,
    activate,
    event,
    emitLog,
    recordFailure,
    settle,
    markRecorded,
    isRecorded,
    recordedBy,
    inject,
    extract,
    suppressed,
    enableTracing,
    isTracing,
    isSuppressed: isSuppressedHere,
    canEmit,
    traceNow,
    newTraceId,
    newSpanId,
    useIds,
    registerFallback,
    toAttributes,
  },

  defaults: {
    *export() {},
    *emit() {},
  },

  *exec(entries, run) {
    let failure: Result.Failure<unknown> | undefined

    for (const entry of entries) {
      const outcome = yield* attempt(() => run(entry))

      if (isFailure(outcome)) {
        failure ??= outcome
      }
    }

    if (failure) {
      return yield* fail(TraceErrors.Tracer, 'a tracer failed', failure)
    }
  },
})
