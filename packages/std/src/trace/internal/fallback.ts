import type { Operation, Scope } from 'std:effect'
import { attempt } from 'std:effect'
import type { AnyType } from 'std:shared'

import { Tracing } from '../definition'
import { TraceCauses } from '../errors'
import type { Helpers } from '../types/helpers'
import type { TraceDef } from '../types/trace'

import { FALLBACK_KEY } from './const'
import { isSuppressed, quietFor } from './context'

const NONE: Helpers.Sinks = Object.freeze([])

// on `globalThis` under a registered symbol: every std copy in the process (a second install of
// the same release, a hot-reload bundle) shares ONE queue — copy-on-write, so a reader holding the
// old array is never disturbed by a register / unregister
const sinksOf = (): Helpers.Sinks =>
  ((globalThis as AnyType)[FALLBACK_KEY] as Helpers.Sinks | undefined) ?? NONE

const store = (sinks: Helpers.Sinks): void => {
  const target: AnyType = globalThis
  target[FALLBACK_KEY] = Object.freeze(sinks)
}

/** Queue `sink` behind the ones already registered; the returned function takes it out (idempotent). */
export const addSink = (sink: TraceDef.FallbackSink): (() => void) => {
  store([...sinksOf(), sink])

  let registered = true

  return () => {
    if (!registered) {
      return
    }

    registered = false
    store(sinksOf().filter(entry => entry !== sink))
  }
}

/**
 * The sink a log record emitted in `scope` falls back to: the FIRST registered one, and only
 * while tracing is not enabled there and telemetry is not suppressed; `undefined` otherwise. One
 * property read when nothing is registered.
 */
export const fallbackFor = (scope: Scope): TraceDef.FallbackSink | undefined => {
  const sink = sinksOf()[0]

  if (sink === undefined || isSuppressed(scope) || scope.get(Tracing)?.enabled === true) {
    return undefined
  }

  return sink
}

/** Hand one record to `sink` — suppressed (no recursion), correlated to the record's own span
 * ({@link quietFor}) and attempted (never fails the caller). */
export function* sendFallback(sink: TraceDef.FallbackSink, log: TraceDef.LogData): Operation<void> {
  yield* attempt(() => quietFor(log, () => sink.emit(log)), TraceCauses.Emit)
}
