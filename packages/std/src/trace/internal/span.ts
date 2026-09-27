import type { Scope } from 'std:effect'

import { ActiveSpan } from '../definition'
import type { Helpers } from '../types/helpers'
import type { TraceDef } from '../types/trace'
import { isValidContext } from '../utils/propagation'

import { APP_SCOPE, FLAG_RANDOM, FLAG_SAMPLED, LIBRARY_SCOPE_PREFIX } from './const'
import { activeOf, isOn } from './context'
import { mintSpanId, mintTraceId } from './ids'
import { LocalTrace, openerOf, SpanRecorder } from './recorder'
import { finish } from './settle'
import { plainContext } from './tree'

const sameSpan = (left: TraceDef.SpanContext, right: TraceDef.SpanContext): boolean =>
  left.traceId === right.traceId && left.spanId === right.spanId

/** An ozaco library's instrumentation scope (`@ozaco/server`, `@ozaco/db`, …). */
const isLibraryScope = (scope: TraceDef.InstrumentationScope): boolean =>
  scope.name.startsWith(LIBRARY_SCOPE_PREFIX)

/**
 * The instrumentation scope of a span opened without one (see `TraceDef.SpanOptions.scope`): its
 * service — its own or the one it inherits — else its local parent's scope unless that is an
 * ozaco library's, else `app`. Code the caller wrote is never labelled a library (`@ozaco/std`).
 */
const scopeFor = (
  service: string | null,
  parent: SpanRecorder | null,
): TraceDef.InstrumentationScope => {
  if (service) {
    return { name: service }
  }

  return parent && !isLibraryScope(parent.scope) ? parent.scope : APP_SCOPE
}

const outcomeOf = (options: TraceDef.EndOptions): Helpers.Outcome =>
  options.failure
    ? { t: 'failed', failure: options.failure }
    : options.cancelled
      ? { t: 'halted' }
      : { t: 'ok' }

/**
 * Open a span in `scope`, or `null` when nothing is to be recorded: tracing off / suppressed, or
 * `requireParent` without a sampled parent. The parent is `options.parent` (`null` ⇒ a new trace;
 * a context ⇒ a local root under it, unless it IS the active span) or the active span (a
 * pass-through one ⇒ a local root under its remote context). Ids: a child keeps its parent's trace
 * id and random flag; a new trace mints one with the random flag. Sampling: a child of an unsampled
 * parent is non-recording (ids exist, nothing exported but its log records); `sampled: false`
 * opts out.
 */
export const open = (
  scope: Scope,
  name: string,
  options: TraceDef.SpanOptions,
): SpanRecorder | null => {
  if (!isOn(scope)) {
    return null
  }

  const active = activeOf(scope)
  let local: SpanRecorder | null = null
  let remote: TraceDef.SpanContext | null = null

  if (options.parent === undefined) {
    if (active?.passThrough) {
      remote = active.context
    } else {
      local = active
    }
  } else if (options.parent !== null && isValidContext(options.parent)) {
    if (active && !active.passThrough && sameSpan(active.context, options.parent)) {
      local = active
    } else {
      remote = options.parent
    }
  }

  const parent = local?.context ?? remote
  const parentSampled = parent !== null && (parent.flags & FLAG_SAMPLED) === FLAG_SAMPLED

  if (options.requireParent && !parentSampled) {
    return null
  }

  const sampled = (parent === null || parentSampled) && options.sampled !== false
  const random = parent === null ? FLAG_RANDOM : parent.flags & FLAG_RANDOM
  const trace = local?.trace ?? new LocalTrace(options.record ?? 'always')

  const context: TraceDef.SpanContext = {
    traceId: parent?.traceId ?? mintTraceId(scope),
    spanId: mintSpanId(scope),
    flags: random | (sampled ? FLAG_SAMPLED : 0),
    ...(parent?.state ? { state: parent.state } : {}),
  }

  const service = options.service ?? local?.service ?? null

  const rec = new SpanRecorder(
    {
      name,
      context,
      parent: parent ? plainContext(parent) : null,
      local,
      kind: options.kind ?? 'internal',
      scope: options.scope ?? scopeFor(service, local),
      service,
      recording: sampled,
      start: options.startTime ?? trace.now(),
      failure: options.failure,
      opener: openerOf(scope),
    },
    trace,
  )

  rec.setAttributes(options.attributes)

  for (const link of options.links ?? []) {
    if (isValidContext(link.context)) {
      rec.addLink(link.context, link.attributes)
    }
  }

  return rec
}

export const liveOf = (rec: SpanRecorder): TraceDef.LiveSpan => ({
  ...rec.handle,
  run: body => ActiveSpan.with(rec, () => body(rec.handle)),
  end: (options = {}) => finish(rec, outcomeOf(options), options.time),
})

/** Nothing recorded: `run` leaves `ActiveSpan` alone (a pass-through context stays visible). */
export const idleOf = (handle: TraceDef.SpanHandle): TraceDef.LiveSpan => ({
  ...handle,
  run: body => body(handle),
  *end() {},
})
