import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, formatFailure, isFailure } from 'std:result'
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
  TraceSeverity,
} from 'std:trace'

import { logAttributes, severityOf } from 'std:logger/transport/trace'

import type { ObserveDef } from '../types/observe'
import type { ServerDef } from '../types/server'
import { scopeOf } from '../utils/trace'

import { DOMAIN_EVENT, FAILURE_KEYS, LOG_LEVELS, SENT_BINDING } from './const'
import { markShown } from './forward'

/** A log line's data split: the line's failure (the first `Failure` among the top-level values —
 * an `Error` given there is folded into one, `asFailure`; lifted out when it sits under `err` /
 * `error`) and the fields left as attributes (every other failure rendered one-line). */
export const splitLog = (
  data: Readonly<Record<string, unknown>> | undefined,
): { failure: Result.Failure<unknown> | null; fields: Record<string, unknown> } => {
  let failure: Result.Failure<unknown> | null = null
  const fields: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data ?? {})) {
    const folded = isFailure(value) ? value : value instanceof Error ? asFailure(value) : null

    if (!folded) {
      fields[key] = value
      continue
    }

    failure ??= folded

    if (!(folded === failure && FAILURE_KEYS.has(key))) {
      fields[key] = formatFailure(folded)
    }
  }

  return { failure, fields }
}

/** `ctx.log` as telemetry: ONE log record on the active span (scope `@ozaco/server`, the Logger
 * bridge's severity / attribute shape). A failure logged at WARN+ inside a recording span is
 * recorded through `recordFailure` (once per trace); elsewhere the line carries its exception
 * attributes. */
export function* emitHandlerLog(
  level: keyof ServerDef.Log,
  msg: string,
  data: Readonly<Record<string, unknown>> | undefined,
): Operation<void> {
  // tracing on here, or a process fallback (an observing node's claim) takes the record
  if (!(yield* canEmit())) {
    return
  }

  const severity = severityOf(LOG_LEVELS[level])
  const { failure, fields } = splitLog(data)
  let exception: TraceDef.Attributes | null = null

  if (failure) {
    const handle = yield* current()
    const serious = severity.number >= TraceSeverity.warn

    if (serious && handle.recording) {
      if (!isRecorded(failure, handle.context.traceId)) {
        // the line itself goes to the Logger (`handlerLog`): its exception record is not
        // forwarded there a second time
        markShown(failure)
        yield* recordFailure(failure, { severity: severity.number })
      }
    } else {
      const traceId = (yield* activeContext())?.traceId ?? ''

      if (!isRecorded(failure, traceId)) {
        exception = exceptionAttributes(failure)

        if (serious) {
          markRecorded(failure, traceId)
        }
      }
    }
  }

  const attributes = logAttributes(fields, new Set(exception ? Object.keys(exception) : []))

  yield* emitLog({
    body: msg || (failure ? formatFailure(failure) : '') || severity.text,
    severityNumber: severity.number,
    severityText: severity.text,
    attributes: exception ? { ...attributes, ...exception } : attributes,
    scope: scopeOf(),
  })
}

/**
 * One `ctx.log.<level>(msg, data)` line (§5): ALWAYS one log record through the Tracer —
 * correlated to the span active NOW, debug included (the Logger's level does not gate telemetry)
 * — AND the line forwarded to the installed std Logger (if any) with the binding
 * `ozaco.telemetry = 'sent'`, which its `TraceTransport` skips: exactly one record whatever was
 * installed in which order. Never fails the handler.
 */
export function* handlerLog(
  level: keyof ServerDef.Log,
  msg: string,
  data?: Readonly<Record<string, unknown>>,
): Operation<void> {
  yield* attempt(() => emitHandlerLog(level, msg, data))

  if ((yield* Logger.context.get()) === undefined) {
    return
  }

  yield* attempt(() =>
    Logger.actions.child(SENT_BINDING, () =>
      data === undefined
        ? Logger.actions[level](msg)
        : Logger.actions[level](msg, data as Record<string, unknown>),
    ),
  )
}

/** A domain record's display line: the stream, then its fields as JSON (Loki shows the body). */
export const domainBody = (stream: string, fields: Readonly<Record<string, unknown>>): string => {
  if (Object.keys(fields).length === 0) {
    return stream
  }

  try {
    return `${stream} ${JSON.stringify(fields)}`
  } catch {
    return stream
  }
}

/**
 * `Server.actions.report({ stream, time?, …fields })` (§6.4): ONE log record every sink receives
 * — `eventName: 'ozaco.domain'`, `ozaco.domain.stream`, the fields flattened into attributes —
 * correlated to the active span. A no-op while nothing observes; never fails the caller.
 */
export function* domainRecord(record: ObserveDef.DomainRecord): Operation<void> {
  const { stream, time, ...fields } = record

  yield* attempt(() =>
    emitLog({
      body: domainBody(stream, fields),
      severityNumber: TraceSeverity.info,
      eventName: DOMAIN_EVENT,
      attributes: { ...logAttributes(fields), 'ozaco.domain.stream': stream },
      time,
      scope: scopeOf(),
    }),
  )
}
