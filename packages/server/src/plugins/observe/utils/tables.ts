import { column, table } from 'db:core'
import { OBSERVE_PREFIX } from 'server:core'

/** The observe tables: plain rows, no change log (history of history is noise). */
export const requests = table(
  `${OBSERVE_PREFIX}requests`,
  {
    request_id: column.text(),
    origin: column.enumOf('external', 'internal'),
    service: column.text().optional(),
    action: column.text().optional(),
    edge: column.text().optional(),
    method: column.text().optional(),
    path: column.text().optional(),
    socket: column.text().optional(),
    status: column.int().optional(),
    service_id: column.text(),
    instance: column.text(),
    lane: column.text(),
    started_at: column.int(),
    ended_at: column.int().optional(),
    duration_ms: column.int().optional(),
    error: column.text().optional(),
    attrs: column.json().optional(),
    headers: column.json().optional(),
    input: column.json().optional(),
    output: column.json().optional(),
  },
  { log: false },
)
  .unique('by_request', ['request_id'])
  .index('by_started', ['started_at'])
  .index('by_error', ['error'])

export const spans = table(
  `${OBSERVE_PREFIX}spans`,
  {
    request_id: column.text(),
    span_id: column.text(),
    parent_span_id: column.text().optional(),
    kind: column.enumOf('edge', 'dispatch', 'plugin', 'carrier', 'db', 'cache', 'lane', 'custom'),
    name: column.text(),
    service_id: column.text(),
    instance: column.text(),
    action_id: column.text().optional(),
    transport: column.text().optional(),
    started_at: column.int(),
    ended_at: column.int(),
    status: column.enumOf('ok', 'failed', 'cancelled'),
    attrs: column.json().optional(),
  },
  { log: false },
)
  .index('by_request', ['request_id'])
  .index('by_started', ['started_at'])

export const logs = table(
  `${OBSERVE_PREFIX}logs`,
  {
    request_id: column.text().optional(),
    span_id: column.text().optional(),
    level: column.enumOf('debug', 'info', 'warn', 'error'),
    msg: column.text(),
    data: column.json().optional(),
    ts: column.int(),
  },
  { log: false },
)
  .index('by_request', ['request_id'])
  .index('by_ts', ['ts'])

export const failures = table(
  `${OBSERVE_PREFIX}failures`,
  {
    request_id: column.text().optional(),
    span_id: column.text().optional(),
    tag: column.text(),
    message: column.text(),
    causes: column.json<readonly string[]>(),
    status: column.int().optional(),
    where: column.text(),
    ts: column.int(),
  },
  { log: false },
)
  .index('by_request', ['request_id'])
  .index('by_tag', ['tag'])

export const events = table(
  `${OBSERVE_PREFIX}events`,
  {
    request_id: column.text().optional(),
    kind: column.enumOf('emit', 'socket-in', 'socket-out', 'lane-open', 'lane-close'),
    name: column.text(),
    size: column.int().optional(),
    data: column.json().optional(),
    ts: column.int(),
  },
  { log: false },
)
  .index('by_request', ['request_id'])
  .index('by_ts', ['ts'])

export const observeTables = [requests, spans, logs, failures, events] as const
