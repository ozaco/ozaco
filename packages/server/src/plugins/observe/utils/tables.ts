import { column, table } from 'db:core'
import { OBSERVE_PREFIX } from 'server:core'

/** The observe tables: plain rows, no change log (history of history is noise). */
export const requests = table(
  `${OBSERVE_PREFIX}requests`,
  {
    requestId: column.text(),
    origin: column.enumOf('external', 'internal'),
    service: column.text().optional(),
    action: column.text().optional(),
    edge: column.text().optional(),
    method: column.text().optional(),
    path: column.text().optional(),
    socket: column.text().optional(),
    status: column.int().optional(),
    serviceId: column.text(),
    instance: column.text(),
    lane: column.text(),
    startedAt: column.int(),
    endedAt: column.int().optional(),
    durationMs: column.int().optional(),
    error: column.text().optional(),
    attrs: column.json().optional(),
  },
  { log: false },
)
  .unique('by_request', ['requestId'])
  .index('by_started', ['startedAt'])
  .index('by_error', ['error'])

export const spans = table(
  `${OBSERVE_PREFIX}spans`,
  {
    requestId: column.text(),
    spanId: column.text(),
    parentSpanId: column.text().optional(),
    kind: column.enumOf('edge', 'dispatch', 'plugin', 'carrier', 'db', 'cache', 'lane', 'custom'),
    name: column.text(),
    serviceId: column.text(),
    instance: column.text(),
    actionId: column.text().optional(),
    transport: column.text().optional(),
    startedAt: column.int(),
    endedAt: column.int(),
    status: column.enumOf('ok', 'failed', 'cancelled'),
    attrs: column.json().optional(),
  },
  { log: false },
)
  .index('by_request', ['requestId'])
  .index('by_started', ['startedAt'])

export const logs = table(
  `${OBSERVE_PREFIX}logs`,
  {
    requestId: column.text().optional(),
    spanId: column.text().optional(),
    level: column.enumOf('debug', 'info', 'warn', 'error'),
    msg: column.text(),
    data: column.json().optional(),
    ts: column.int(),
  },
  { log: false },
)
  .index('by_request', ['requestId'])
  .index('by_ts', ['ts'])

export const failures = table(
  `${OBSERVE_PREFIX}failures`,
  {
    requestId: column.text().optional(),
    spanId: column.text().optional(),
    tag: column.text(),
    message: column.text(),
    causes: column.json<readonly string[]>(),
    status: column.int().optional(),
    where: column.text(),
    ts: column.int(),
  },
  { log: false },
)
  .index('by_request', ['requestId'])
  .index('by_tag', ['tag'])

export const events = table(
  `${OBSERVE_PREFIX}events`,
  {
    requestId: column.text().optional(),
    kind: column.enumOf('emit', 'socket-in', 'socket-out', 'lane-open', 'lane-close'),
    name: column.text(),
    size: column.int().optional(),
    ts: column.int(),
  },
  { log: false },
)
  .index('by_request', ['requestId'])
  .index('by_ts', ['ts'])

export const observeTables = [requests, spans, logs, failures, events] as const
