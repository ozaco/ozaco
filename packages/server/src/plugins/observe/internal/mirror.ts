// oxlint-disable import/exports-last
import type { ObserveDef } from 'server:core'
import type { TraceDef } from 'std:trace'

/** OTel severity number → its range's name (TRACE 1-4, DEBUG 5-8, … FATAL 21-24). */
const SEVERITIES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const

/** Multi-line attribute values print as an indented block under their line, not inline. */
const BLOCK_KEYS: ReadonlySet<string> = new Set(['exception.stacktrace'])

const INDENT = '    '

/** Wall-clock time of day (UTC) with milliseconds. */
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 23)

/** One scalar as printed: a number as JS writes it (`NaN` / `Infinity` stay what they are —
 * JSON would print `null`), a string JSON-quoted. */
const scalar = (item: string | number | boolean): string =>
  typeof item === 'string' ? JSON.stringify(item) : String(item)

/** A value as a `key=value` token: bare when it is one word, JSON-like otherwise. */
const token = (value: TraceDef.AttrValue): string => {
  if (typeof value === 'string') {
    return /^[^\s"=]+$/u.test(value) ? value : JSON.stringify(value)
  }

  return Array.isArray(value)
    ? `[${(value as readonly (string | number | boolean)[]).map(scalar).join(',')}]`
    : scalar(value as number | boolean)
}

const tokens = (attributes: TraceDef.Attributes | undefined, skip = BLOCK_KEYS): string => {
  const parts = Object.entries(attributes ?? {})
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => `${key}=${token(value)}`)

  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/** The multi-line values of `attributes` (a failure's chain) not already shown as `shown`, each
 * line indented by `indent`. */
const blocks = (attributes: TraceDef.Attributes, shown: string, indent = INDENT): string[] =>
  [...BLOCK_KEYS]
    .map(key => attributes[key])
    .filter(
      (value): value is string => typeof value === 'string' && value !== '' && value !== shown,
    )
    .flatMap(value => value.split('\n').map(line => `${indent}${line}`))

const severityOf = (log: TraceDef.LogData): string =>
  log.severityText ??
  SEVERITIES[
    Math.min(SEVERITIES.length - 1, Math.max(0, Math.floor((log.severityNumber - 1) / 4)))
  ] ??
  String(log.severityNumber)

/** `ok`, `✗ <error.type>` (a failure the span did not count as its own error — a 4xx) or
 * `✗ <error.type> ERROR: <message>` (status error). */
const outcomeOf = (span: TraceDef.SpanData): string => {
  const type = span.attributes['error.type']

  if (span.status.code === 'error') {
    const message = span.status.message ? `: ${span.status.message}` : ''

    return `✗ ${type === undefined ? 'error' : token(type)} ERROR${message}`
  }

  return type === undefined ? 'ok' : `✗ ${token(type)}`
}

const spanLines = (span: TraceDef.SpanData, resource: ObserveDef.Resource): string[] => {
  const duration = Math.max(0, span.end - span.start).toFixed(2)
  const parent = span.parent ? ` parent_id=${span.parent.spanId}` : ''
  const lines = [
    `[oz] ${clock(span.start)} ${resource['service.name']} ${span.kind.toUpperCase()} ${span.name} ${duration}ms ${outcomeOf(span)} trace_id=${span.context.traceId} span_id=${span.context.spanId}${parent}${tokens(span.attributes)}`,
  ]

  for (const event of span.events) {
    lines.push(
      `${INDENT}· ${clock(event.time)} +${Math.max(0, event.time - span.start).toFixed(2)}ms ${event.name}${tokens(event.attributes)}`,
      // an exception event's own (budgeted) stacktrace, as a block under it: stdout holds the
      // event exactly as every other sink does
      ...blocks(event.attributes ?? {}, '', `${INDENT}${INDENT}`),
    )
  }

  for (const link of span.links) {
    lines.push(
      `${INDENT}↗ link trace_id=${link.context.traceId} span_id=${link.context.spanId}${tokens(link.attributes)}`,
    )
  }

  if (span.droppedAttributes + span.droppedEvents + span.droppedLinks > 0) {
    lines.push(
      `${INDENT}dropped attributes=${span.droppedAttributes} events=${span.droppedEvents} links=${span.droppedLinks}`,
    )
  }

  return lines
}

const logLines = (log: TraceDef.LogData, resource: ObserveDef.Resource): string[] => {
  const ids = log.context ? ` trace_id=${log.context.traceId} span_id=${log.context.spanId}` : ''
  const event = log.eventName ? ` [${log.eventName}]` : ''
  // a multi-line body (an exception record's chain) prints its first line in place, the rest
  // indented under it — the ids and attributes stay on the record's own line
  const [head = '', ...rest] = log.body.split('\n')

  return [
    `[oz] ${clock(log.time)} ${resource['service.name']} ${severityOf(log)} ${log.scope.name}${event} ${head}${ids}${tokens(log.attributes)}`,
    ...rest.map(line => `${INDENT}${line}`),
    ...blocks(log.attributes, log.body),
  ]
}

/**
 * The stdout rendering of one observed record (dev): a finished span is ONE compact line — time,
 * service, kind, name, duration, outcome, `trace_id=` / `span_id=` / `parent_id=` and its
 * attributes — with its events (an `exception` event's `exception.stacktrace` as a block under
 * it) and links indented under it; a log record is one line (severity, scope, event name, body,
 * ids, attributes) with a failure's full chain (the rest of a multi-line body, else
 * `exception.stacktrace`) indented under it. It is the same record every sink gets — a
 * multi-line value equal to the record's body is not printed twice.
 */
export const mirrorLines = (event: ObserveDef.Event): string[] =>
  event.t === 'span' ? spanLines(event.span, event.resource) : logLines(event.log, event.resource)

/** Print {@link mirrorLines} to stdout. */
export const mirror = (event: ObserveDef.Event): void => {
  console.log(mirrorLines(event).join('\n'))
}
