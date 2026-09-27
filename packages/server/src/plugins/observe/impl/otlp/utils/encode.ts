import { CONTENT_TYPES } from '../internal/const'
import { jsonLogs, jsonTraces } from '../internal/json'
import { protobufLogs, protobufTraces } from '../internal/protobuf'
import { groupByResource } from '../internal/resource'
import type { OtlpDef } from '../types/otlp'

/**
 * Observed spans as ONE OTLP `ExportTraceServiceRequest` — protobuf (default) or OTLP/JSON: one
 * resource block per (service.name, service.instance.id) of the events' resources (`resource`
 * underneath), one scope block per instrumentation scope, status omitted while unset, span / link
 * flags carrying the W3C flags plus the is-remote bits. The encoder `OtlpExporter` and
 * `OpenObserveExporter` ship with — usable for an OTLP destination of one's own.
 */
export const encodeSpans = (
  events: readonly OtlpDef.SpanEvent[],
  options: OtlpDef.EncodeOptions = {},
): OtlpDef.Encoded => {
  const encoding = options.encoding ?? 'protobuf'
  const groups = groupByResource(
    events.map(event => ({ resource: event.resource, scope: event.span.scope, item: event.span })),
    options.resource ?? {},
  )

  return {
    body: encoding === 'json' ? jsonTraces(groups) : protobufTraces(groups),
    contentType: CONTENT_TYPES[encoding],
    items: events.length,
  }
}

/**
 * Observed log records as ONE OTLP `ExportLogsServiceRequest` (grouped like
 * {@link encodeSpans}): each record exactly as the kernel reported it — its attributes were cut
 * to the log budget ONCE, before the fan-out (every sink holds the same record; nothing is cut
 * again here) — `flags` = the trace flags, `eventName` kept.
 */
export const encodeLogs = (
  events: readonly OtlpDef.LogEvent[],
  options: OtlpDef.EncodeOptions = {},
): OtlpDef.Encoded => {
  const encoding = options.encoding ?? 'protobuf'
  const groups = groupByResource(
    events.map(event => ({
      resource: event.resource,
      scope: event.log.scope,
      item: event.log,
    })),
    options.resource ?? {},
  )

  return {
    body: encoding === 'json' ? jsonLogs(groups) : protobufLogs(groups),
    contentType: CONTENT_TYPES[encoding],
    items: events.length,
  }
}
