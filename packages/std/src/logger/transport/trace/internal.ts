import type { Operation } from 'std:effect'
import type { Result } from 'std:result'
import type { TraceDef } from 'std:trace'
import {
  activeContext,
  canEmit,
  current,
  emitLog,
  exceptionAttributes,
  isRecorded,
  markRecorded,
  recordFailure,
} from 'std:trace'

import pkg from '../../../../package.json'
import { LogLevel } from '../../const'
import { TELEMETRY_BINDING, TELEMETRY_SENT } from '../../internal/const'
import type { LoggerDef } from '../../types/logger'

import { logAttributes, severityOf } from './utils'

/**
 * Record the entry's first failure — logged at WARN or above inside a RECORDING span — through
 * std:trace `recordFailure` (an `exception` span event + ONE exception record, once per trace:
 * a later escape of the same failure only sets the spans' status). Whether it was recorded HERE.
 */
function* recordOnSpan(
  failure: Result.Failure<unknown>,
  traceId: string,
  severity: number,
): Operation<boolean> {
  if (isRecorded(failure, traceId)) {
    return false
  }

  yield* recordFailure(failure, { severity })
  return true
}

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
export const attributesOf = (
  entry: LoggerDef.Entry,
  taken?: ReadonlySet<string>,
): Record<string, TraceDef.AttrValue> => {
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

  return logAttributes(Object.fromEntries(fields), taken)
}

/**
 * Hand one entry to the Tracer as a log record (`emitLog`): correlated to the entry's span (else
 * the active one), severity by level, `severityText` the level's name, body the message (the
 * failure's one-liner when there is none), scope the `logger` binding (default
 * `@ozaco/std/logger`), attributes the flattened bindings + data.
 *
 * The entry's first failure: at WARN+ inside a RECORDING span it goes to `recordFailure` (the
 * line carries no exception attributes, and a line that would only repeat the exception — no
 * message, no data — is not emitted); otherwise the line carries its exception attributes
 * (unless the failure already has an exception record in the line's trace), and at WARN+ the
 * failure is marked recorded there (its later escape adds no second exception record).
 *
 * Where tracing is OFF (never enabled — infrastructure installed outside every observing node)
 * the record still goes out, through the process FALLBACK sink (`registerFallback`: the first
 * observing server in the process): no span is written there, so a failure rides on the line as
 * exception attributes. Nothing happens while suppressed, with tracing off and no fallback
 * registered, or for an entry `ctx.log` already emitted.
 */
export function* forward(entry: LoggerDef.Entry): Operation<void> {
  if (isSent(entry) || !(yield* canEmit())) {
    return
  }

  const severity = severityOf(entry.level)
  const failure = entry.failures[0]
  let exception: TraceDef.Attributes | undefined

  if (failure) {
    const handle = yield* current()
    const serious = entry.level >= LogLevel.warn

    if (serious && handle.recording) {
      const recorded = yield* recordOnSpan(failure, handle.context.traceId, severity.number)

      if (recorded && !entry.msg && !entry.data) {
        return
      }
    } else {
      const traceId = (entry.trace ?? (yield* activeContext()))?.traceId ?? ''

      // already an exception record in this trace: the line stays a plain line
      if (!isRecorded(failure, traceId)) {
        exception = exceptionAttributes(failure)

        if (serious) {
          markRecorded(failure, traceId)
        }
      }
    }
  }

  const attributes = attributesOf(entry, new Set(exception ? Object.keys(exception) : []))

  yield* emitLog({
    body: entry.msg || entry.error || severity.text,
    severityNumber: severity.number,
    severityText: severity.text,
    attributes: exception ? { ...attributes, ...exception } : attributes,
    time: entry.time,
    scope: scopeOf(entry.bindings),
    ...(entry.trace ? { context: entry.trace } : {}),
  })
}
