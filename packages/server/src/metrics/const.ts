import type { Column } from 'db:realtime'

const column = (name: string, kind: Column['kind']): Column => ({
  name,
  kind,
  optional: true,
  hasDefault: false,
  enumValues: null,
  reference: null,
})

export const METRICS_SUBTYPE = Symbol.for('server:metrics')

export const CALLS_TABLE = 'calls'
export const LOGS_TABLE = 'logs'
export const EVENTS_TABLE = 'events'

export const DEFAULT_STORE_PATH = ':memory:'
export const DEFAULT_FLUSH_INTERVAL_MS = 1000

/** The well-known broker ADDRESS of the metrics sink service — what a `sink: 'forward'` collector
 * ships to and delegates reads to. One name, no config: forwarders and the sink must agree. */
export const METRICS_SERVICE_NAME = 'metrics-sink'
/** Per-table cap on rows a forward-mode collector keeps for retry while the sink is unreachable
 * (e.g. the boot window before the broker/transport is up) — bounds memory, oldest rows drop first. */
export const FORWARD_PENDING_CAP = 10_000

// Column names match the record field names (quoted camelCase in SQL) so a MongoDB-style filter reads
// naturally — `{ durationMs: { $gt: 5 } }`. `meta` holds arbitrary custom fields as JsonCodec text
// (never a native JSON column), preserved on insert and decoded back on read.
export const CALL_COLUMNS = [
  'ts',
  'service',
  'action',
  'status',
  'durationMs',
  'error',
  'meta',
] as const
export const LOG_COLUMNS = ['ts', 'level', 'msg', 'error', 'meta'] as const
// The general-purpose custom store: a named event with an optional numeric `value` (metric/gauge) plus
// arbitrary custom fields in `meta`. This is the "normal insert" — anything that isn't a call or a log.
export const EVENT_COLUMNS = ['ts', 'name', 'value', 'meta'] as const

// `ts` is epoch-ms (BIGINT) — time-series queries bucket it with
// `time_bucket(INTERVAL '1 minute', make_timestamp(ts * 1000))`.
export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${CALLS_TABLE} (
    "ts" BIGINT NOT NULL,
    "service" VARCHAR NOT NULL,
    "action" VARCHAR NOT NULL,
    "status" VARCHAR NOT NULL,
    "durationMs" DOUBLE NOT NULL,
    "error" VARCHAR,
    "meta" VARCHAR
  )`,
  `CREATE TABLE IF NOT EXISTS ${LOGS_TABLE} (
    "ts" BIGINT NOT NULL,
    "level" INTEGER NOT NULL,
    "msg" VARCHAR,
    "error" VARCHAR,
    "meta" VARCHAR
  )`,
  `CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
    "ts" BIGINT NOT NULL,
    "name" VARCHAR NOT NULL,
    "value" DOUBLE,
    "meta" VARCHAR
  )`,
]

// The filterable columns for {@link compileFilter} (a MongoDB-style filter over standard fields;
// `meta` is intentionally excluded — custom fields ride in it but aren't individually filtered).
export const CALL_FILTER_COLUMNS: readonly Column[] = [
  column('ts', 'int'),
  column('service', 'text'),
  column('action', 'text'),
  column('status', 'text'),
  column('durationMs', 'float'),
  column('error', 'text'),
]
export const LOG_FILTER_COLUMNS: readonly Column[] = [
  column('ts', 'int'),
  column('level', 'int'),
  column('msg', 'text'),
  column('error', 'text'),
]
export const EVENT_FILTER_COLUMNS: readonly Column[] = [
  column('ts', 'int'),
  column('name', 'text'),
  column('value', 'float'),
]
