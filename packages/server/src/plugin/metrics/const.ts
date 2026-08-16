import type { MetricsStoreDef } from 'server:core'
import { LogLevel } from 'std:logger'

/** The three built-in tables every metrics store carries. */
export const METRICS_TABLES = {
  calls: 'calls',
  logs: 'logs',
  events: 'events',
} as const

export type MetricsTableName = (typeof METRICS_TABLES)[keyof typeof METRICS_TABLES]

/** How often the collector drains its buffers into the store. */
export const DEFAULT_FLUSH_INTERVAL_MS = 1000

/** Log entries below this level are not captured into the `logs` table by default. */
export const DEFAULT_LOG_LEVEL = LogLevel.warn

/** Per-buffer cap — when full, the OLDEST buffered item is dropped (at-most-once semantics). */
export const METRICS_BUFFER_CAP = 10_000

/**
 * Store-portable schemas of the built-in tables, mirroring the core `MetricsStoreDef.CallRecord` / `MetricsStoreDef.LogRecord` /
 * `MetricsStoreDef.EventRecord` row shapes. SQL-backed store impls create these at `init()`.
 */
export const BUILTIN_TABLE_SPECS: readonly MetricsStoreDef.DefineSpec[] = [
  {
    table: METRICS_TABLES.calls,
    columns: [
      { name: 'ts', kind: 'timestamp' },
      { name: 'service', kind: 'text' },
      { name: 'action', kind: 'text' },
      { name: 'status', kind: 'text' },
      { name: 'durationMs', kind: 'float' },
      { name: 'requestId', kind: 'text' },
      { name: 'serviceId', kind: 'text' },
      { name: 'laneId', kind: 'text' },
      { name: 'actionId', kind: 'text' },
      { name: 'parentActionId', kind: 'text' },
      { name: 'outcome', kind: 'text' },
      { name: 'delivered', kind: 'boolean' },
      { name: 'origin', kind: 'text' },
      { name: 'transport', kind: 'text' },
      { name: 'error', kind: 'text' },
      { name: 'causes', kind: 'json' },
      { name: 'meta', kind: 'json' },
    ],
  },
  {
    table: METRICS_TABLES.logs,
    columns: [
      { name: 'ts', kind: 'timestamp' },
      { name: 'level', kind: 'int' },
      { name: 'msg', kind: 'text' },
      { name: 'requestId', kind: 'text' },
      { name: 'serviceId', kind: 'text' },
      { name: 'actionId', kind: 'text' },
      { name: 'error', kind: 'text' },
      { name: 'meta', kind: 'json' },
    ],
  },
  {
    table: METRICS_TABLES.events,
    columns: [
      { name: 'ts', kind: 'timestamp' },
      { name: 'name', kind: 'text' },
      { name: 'value', kind: 'float' },
      { name: 'meta', kind: 'json' },
    ],
  },
]
