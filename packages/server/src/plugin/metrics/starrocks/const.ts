import type { MetricsStoreDef } from 'server:core'

/** MySQL-protocol port of the FE, used when `queryUrl` is not given. */
export const DEFAULT_QUERY_PORT = 9030

export const DEFAULT_USER = 'root'

export const DEFAULT_LABEL_PREFIX = 'ozaco-metrics'

/** Stream Load FE→BE hops we are willing to follow manually. */
export const MAX_REDIRECTS = 5

/**
 * `MetricsStoreDef.Column.kind` → StarRocks column type. `json` maps to STRING deliberately: the collector
 * ships pre-serialized JSON text (causes/meta) and STRING keeps it queryable via the JSON
 * functions without the JSON type's ingestion strictness.
 */
export const COLUMN_TYPES: Record<MetricsStoreDef.Column['kind'], string> = {
  text: 'VARCHAR(65533)',
  int: 'BIGINT',
  float: 'DOUBLE',
  boolean: 'BOOLEAN',
  timestamp: 'BIGINT',
  json: 'STRING',
}
