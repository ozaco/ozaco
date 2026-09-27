import type { Context } from 'std:effect'
import { attempt, createContext, markContextAsSnapshot } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { defineProtocol } from 'std:plugin'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import pkg from '../../package.json'

import { TRACER } from './const'
import { TraceErrors } from './errors'
import type { TraceDef } from './types/trace'

/**
 * Whether spans are recorded in a scope — the value of the LIVE {@link Tracing} context. A class
 * instance, so a flip made after forks were created is seen by all of them (a snapshot context
 * would have copied a plain object into every fork).
 */
export class TracingState {
  enabled: boolean

  constructor(enabled = false) {
    this.enabled = enabled
  }
}

/**
 * The span the running operation belongs to: a recording / non-recording span, a pass-through
 * inbound context (`passThrough()`), or `null` (none). A SNAPSHOT context holding class
 * instances: every fork of a span body shares the one recorder. Set it only with
 * `ActiveSpan.with(passThrough(context), body)` or `null`.
 */
export const ActiveSpan: Context<TraceDef.ActiveRecorder | null> = markContextAsSnapshot(
  // default `null` (not `undefined`): an own `null` survives `ActiveSpan.with` restoring it
  createContext<TraceDef.ActiveRecorder | null>('std:trace.span', null),
)

/** Whether tracing is on here — LIVE (never snapshot). Set by `enableTracing()`. */
export const Tracing: Context<TracingState> = createContext<TracingState>('std:trace.state')

/** Telemetry-internal code runs suppressed (`suppressed()`): no spans, no records, unsampled propagation. */
export const Suppressed: Context<boolean> = markContextAsSnapshot(
  createContext<boolean>('std:trace.suppressed', false),
)

/** Pins trace / span id generation (tests); default `crypto.getRandomValues`. */
export const TraceIds: Context<TraceDef.Ids> = createContext<TraceDef.Ids>('std:trace.ids')

/**
 * Where finished spans and log records go: CLONEABLE, every call fans out to EVERY install in
 * install order (an in-memory test tracer next to the server's). Defaults are no-ops, so a scope
 * without an install drops everything. An impl's `setup` turns tracing on for its scope with
 * `enableTracing()`; one install failing never stops the others (the first failure is raised
 * after all ran, tagged `TraceErrors.Tracer`) — std:trace itself never lets a Tracer failure
 * reach traced code.
 */
export const Tracer: Protocol<unknown, TraceDef.TracerActions> = defineProtocol<
  unknown,
  TraceDef.TracerActions
>({
  name: 'std/tracer',
  version: pkg.version,
  description: 'Receives finished spans (`export`) and log records (`emit`)',

  subtype: TRACER,
  cloneable: true,

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
