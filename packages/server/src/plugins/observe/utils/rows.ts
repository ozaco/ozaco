// oxlint-disable import/exports-last
import type { ObserveDef } from 'server:core'
import type { TraceDef } from 'std:trace'

import { int, resourceOfRow, restOf, scopeOfRow, text } from '../internal/rows'

/** Whether a log record is an EXCEPTION record (its event name ends in `exception`:
 * `exception`, `ozaco.action.exception`, `http.server.request.exception`, …). */
export const isExceptionLog = (row: Pick<ObserveDef.LogRow, 'event_name'>): boolean =>
  row.event_name !== null && /(?:^|\.)exception$/u.test(row.event_name)

/**
 * The `_ob2_spans` row of one observed span: the SpanData's hot fields as columns
 * (`error_type` ← `error.type`, `http_route` ← `http.route`, `http_status` ←
 * `http.response.status_code`, `request_id` ← `ozaco.request.id`), the rest as json, and its
 * resource. `root` = a LOCAL root: no parent, or a remote one.
 */
export const spanRowOf = (
  span: TraceDef.SpanData,
  resource: ObserveDef.Resource,
): ObserveDef.SpanRow => {
  const attrs = span.attributes

  return {
    trace_id: span.context.traceId,
    span_id: span.context.spanId,
    parent_span_id: span.parent?.spanId ?? null,
    name: span.name,
    kind: span.kind,
    scope: span.scope.name,
    scope_version: span.scope.version ?? null,
    service_name: resource['service.name'],
    service_instance_id: resource['service.instance.id'],
    start: span.start,
    end: span.end,
    duration_ms: Math.max(0, span.end - span.start),
    status_code: span.status.code,
    status_message: span.status.message ?? null,
    error_type: text(attrs['error.type']),
    root: span.parent === null || span.parent.remote === true,
    http_route: text(attrs['http.route']),
    http_status: int(attrs['http.response.status_code']),
    request_id: text(attrs['ozaco.request.id']),
    flags: span.context.flags,
    trace_state: span.context.state ?? null,
    attributes: attrs,
    events: span.events,
    links: span.links,
    dropped_attributes: span.droppedAttributes,
    dropped_events: span.droppedEvents,
    dropped_links: span.droppedLinks,
    resource: restOf(resource),
  }
}

/** The `_ob2_logs` row of one observed log record, with its resource. */
export const logRowOf = (
  log: TraceDef.LogData,
  resource: ObserveDef.Resource,
): ObserveDef.LogRow => ({
  trace_id: log.context?.traceId ?? null,
  span_id: log.context?.spanId ?? null,
  flags: log.context?.flags ?? null,
  time: log.time,
  observed_time: log.observedTime,
  severity_number: log.severityNumber,
  severity_text: log.severityText ?? null,
  body: log.body,
  event_name: log.eventName ?? null,
  service_name: resource['service.name'],
  service_instance_id: resource['service.instance.id'],
  scope: log.scope.name,
  scope_version: log.scope.version ?? null,
  attributes: log.attributes,
  dropped_attributes: log.droppedAttributes,
  resource: restOf(resource),
})

/**
 * The observed event a stored span row came from — what every exporter received. `span.service`
 * is the RESOLVED `service.name` (the row keeps the resource, not whether the span named its
 * service itself); the parent context is rebuilt from its id (a remote parent when the row is a
 * root that has one).
 */
export const eventOfSpanRow = (row: ObserveDef.SpanRow): ObserveDef.Event => ({
  t: 'span',
  span: {
    context: {
      traceId: row.trace_id,
      spanId: row.span_id,
      flags: row.flags,
      ...(row.trace_state === null ? {} : { state: row.trace_state }),
    },
    parent:
      row.parent_span_id === null
        ? null
        : {
            traceId: row.trace_id,
            spanId: row.parent_span_id,
            flags: row.flags,
            ...(row.root ? { remote: true } : {}),
          },
    name: row.name,
    kind: row.kind,
    service: row.service_name,
    scope: scopeOfRow(row),
    start: row.start,
    end: row.end,
    attributes: row.attributes,
    droppedAttributes: row.dropped_attributes,
    events: row.events,
    droppedEvents: row.dropped_events,
    links: row.links,
    droppedLinks: row.dropped_links,
    status:
      row.status_message === null
        ? { code: row.status_code }
        : { code: row.status_code, message: row.status_message },
  },
  resource: resourceOfRow(row),
})

/** The observed event a stored log row came from (`log.service` = the resolved `service.name`). */
export const eventOfLogRow = (row: ObserveDef.LogRow): ObserveDef.Event => ({
  t: 'log',
  log: {
    time: row.time,
    observedTime: row.observed_time,
    severityNumber: row.severity_number,
    ...(row.severity_text === null ? {} : { severityText: row.severity_text }),
    body: row.body,
    ...(row.event_name === null ? {} : { eventName: row.event_name }),
    attributes: row.attributes,
    droppedAttributes: row.dropped_attributes,
    context:
      row.trace_id === null || row.span_id === null
        ? null
        : { traceId: row.trace_id, spanId: row.span_id, flags: row.flags ?? 0 },
    service: row.service_name,
    scope: scopeOfRow(row),
  },
  resource: resourceOfRow(row),
})
