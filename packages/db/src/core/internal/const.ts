import { FIELDS } from '../const'

/** `db.system.name` by adapter name (an adapter's own `telemetry.system` wins). */
export const DB_SYSTEMS: Readonly<Record<string, string>> = {
  pg: 'postgresql',
  'bun-sql': 'postgresql',
  sqlite: 'sqlite',
  memory: 'ozaco.memory',
}

/** The `db.system.name` of an in-process store: its spans are INTERNAL, not CLIENT. */
export const MEMORY_SYSTEM = 'ozaco.memory'

/** The event name of the exception record a failure originating in a db span gets. */
export const DB_EXCEPTION_EVENT = 'db.client.operation.exception'

/** The span event a transaction retried after a conflict leaves on the caller's span. */
export const TX_RETRY_EVENT = 'db.tx.retry'

/** The `logger` binding (the telemetry scope) of the operational log lines. */
export const LOGGER_NAME = '@ozaco/db'

/** A five-character SQLSTATE (`23505`, `40001`, …). */
export const SQLSTATE = /^[0-9A-Z]{5}$/u

/** Statement texts one span keeps (a call that ran more is joined with `; ` up to this many). */
export const MAX_QUERY_TEXTS = 8

/** How deep `db.response.status_code` looks for a status cause in a failure's nested causes. */
export const STATUS_CODE_DEPTH = 8

/** The attribute keys of the bus' operational log lines (the peer, its envelope sequence numbers
 * and the tokens this node refused). */
export const BUS_ORIGIN = 'ozaco.db.bus.origin'
export const BUS_SEQ = 'ozaco.db.bus.seq'
export const BUS_EXPECTED_SEQ = 'ozaco.db.bus.expected_seq'
export const BUS_REJECTED = 'ozaco.db.bus.rejected'

/** The process-wide record of the peers a hub announced (`globalThis` key, shared by every hub
 * and every copy of this module in the process). */
export const BUS_ANNOUNCED = Symbol.for('db:bus.announced')

/** The implicit system field names (`_id`, `_created_at`, `_updated_at`, `_version`). */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set(Object.values(FIELDS))

/** The page size `Kv.actions.keys` scans when the caller names none. */
export const DEFAULT_KEYS_LIMIT = 100

/** The key segment tag sets live under: `{prefix}:$tag:{tag}`. */
export const TAG_SEGMENT = '$tag'
