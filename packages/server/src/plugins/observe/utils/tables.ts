import { column, table } from 'db:core'
import type { TraceDef } from 'std:trace'

import { PREFIX } from '../internal/const'
import type { Helpers } from '../types/helpers'

/**
 * Finished spans — one row per SpanData, with its resource. The hot fields are columns (what the
 * console lists, filters and sorts by); attributes, events and links stay json. `root` = a LOCAL
 * root (no parent, or a remote one). No change log: history of history is noise.
 */
export const observeSpans = table(
  `${PREFIX}spans`,
  {
    trace_id: column.text(),
    span_id: column.text(),
    parent_span_id: column.text().optional(),
    name: column.text(),
    kind: column.enumOf('internal', 'server', 'client', 'producer', 'consumer'),
    scope: column.text(),
    scope_version: column.text().optional(),
    service_name: column.text(),
    service_instance_id: column.text(),
    start: column.float(),
    end: column.float(),
    duration_ms: column.float(),
    status_code: column.enumOf('unset', 'error'),
    status_message: column.text().optional(),
    error_type: column.text().optional(),
    root: column.boolean(),
    http_route: column.text().optional(),
    http_status: column.int().optional(),
    request_id: column.text().optional(),
    flags: column.int(),
    trace_state: column.text().optional(),
    attributes: column.json<TraceDef.Attributes>(),
    events: column.json<readonly TraceDef.SpanEvent[]>(),
    links: column.json<readonly TraceDef.Link[]>(),
    dropped_attributes: column.int(),
    dropped_events: column.int(),
    dropped_links: column.int(),
    resource: column.json<Helpers.ResourceAttributes>(),
  },
  { log: false },
)
  .index('by_trace', ['trace_id'])
  .index('by_root', ['root', 'start'])
  .index('by_start', ['start'])
  .index('by_request', ['request_id'])

/** Log records — Logger lines, `ctx.log`, exceptions (an exception `event_name`), events and
 * domain records — correlated to their span by `trace_id` / `span_id`, with their resource. */
export const observeLogs = table(
  `${PREFIX}logs`,
  {
    trace_id: column.text().optional(),
    span_id: column.text().optional(),
    flags: column.int().optional(),
    time: column.float(),
    observed_time: column.float(),
    severity_number: column.int(),
    severity_text: column.text().optional(),
    body: column.text(),
    event_name: column.text().optional(),
    service_name: column.text(),
    service_instance_id: column.text(),
    scope: column.text(),
    scope_version: column.text().optional(),
    attributes: column.json<TraceDef.Attributes>(),
    dropped_attributes: column.int(),
    resource: column.json<Helpers.ResourceAttributes>(),
  },
  { log: false },
)
  .index('by_trace', ['trace_id'])
  .index('by_time', ['time'])

/** Every table the observe store declares. */
export const observeTables = [observeSpans, observeLogs] as const
