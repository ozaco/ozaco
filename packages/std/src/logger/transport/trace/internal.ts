import type { Operation } from 'std:effect'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import pkg from '../../../../package.json'
import { TELEMETRY_BINDING, TELEMETRY_SENT } from '../../internal/const'
import type { LoggerDef } from '../../types/logger'

import { logAttributes, severityOf } from './utils'

/** The instrumentation scope of a record whose entry has no `logger` binding. */
export const LOGGER_SCOPE: TraceDef.InstrumentationScope = Object.freeze({
  name: '@ozaco/std/logger',
  version: pkg.version,
})

/** The binding naming the logger: it becomes the record's scope name (and no attribute). */
export const SCOPE_BINDING = 'logger'

/** The scope a `logger` binding names: a non-empty string; anything else names nothing. */
export const scopeName = (bindings: Record<string, unknown>): string | undefined => {
  const name = bindings[SCOPE_BINDING]

  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/** The record's scope: the one the `logger` binding names, else {@link LOGGER_SCOPE}. */
export const scopeOf = (bindings: Record<string, unknown>): TraceDef.InstrumentationScope => {
  const name = scopeName(bindings)

  return name ? { name } : LOGGER_SCOPE
}

/** Whether `ctx.log` already emitted this entry itself (binding `ozaco.telemetry = 'sent'`). */
export const isSent = (entry: LoggerDef.Entry): boolean =>
  entry.bindings[TELEMETRY_BINDING] === TELEMETRY_SENT

/**
 * The entry's bindings + data as log attributes ({@link logAttributes}): data wins over a binding
 * of the same key, a `logger` binding naming the scope is left out.
 */
export function* attributesOf(
  entry: LoggerDef.Entry,
): Operation<Record<string, TraceDef.AttrValue>> {
  const fields = new Map<string, unknown>()
  const scoped = scopeName(entry.bindings) !== undefined

  for (const [key, value] of Object.entries(entry.bindings)) {
    if (!(scoped && key === SCOPE_BINDING)) {
      fields.set(key, value)
    }
  }

  for (const [key, value] of Object.entries(entry.data ?? {})) {
    fields.set(key, value)
  }

  return yield* logAttributes(Object.fromEntries(fields))
}

/**
 * Hand one entry to the sinks as a log record (`Trace.actions.emitLog`): correlated to the entry's
 * span (else the active one), severity by level, `severityText` the level's name, body the message
 * (the failure's one-liner when there is none), scope the `logger` binding (default
 * `@ozaco/std/logger`), attributes the flattened bindings + data, the entry's first failure as the
 * record's `failure` — a line that would only repeat its exception record (no message, no data)
 * is not emitted.
 *
 * Where tracing is OFF (never enabled — infrastructure installed outside every observing node)
 * the record still goes out, through the process FALLBACK sink (the first observing server in the
 * process). Nothing happens while suppressed, with tracing off and no fallback registered, or for
 * an entry `ctx.log` already emitted.
 */
export function* forward(entry: LoggerDef.Entry): Operation<void> {
  if (isSent(entry) || !(yield* Trace.actions.canEmit())) {
    return
  }

  const severity = severityOf(entry.level)

  yield* Trace.actions.emitLog({
    body: entry.msg || entry.error || severity.text,
    severityNumber: severity.number,
    severityText: severity.text,
    attributes: yield* attributesOf(entry),
    time: entry.time,
    scope: scopeOf(entry.bindings),
    ...(entry.trace ? { context: entry.trace } : {}),
    failure: entry.failures[0],
    omitRecorded: !entry.msg && !entry.data,
  })
}
