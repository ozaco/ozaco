/**
 * `@ozaco/server/metrics` (`server:metrics`) — a self-contained, separately-imported metrics/analytics
 * module. Install {@link MetricsCollector} to auto-collect internal call metrics (via the metrics
 * policy) and logs (via a logger transport) into an isolated store whose main driver is DuckDB
 * ({@link createDuckdbStore}), then query it with `Metrics.actions.query(...)`. The storage drivers
 * live inside this module, so nothing else needs `@ozaco/db` wiring.
 */
export * from './types'

export * from './definition'

export { createDuckdbStore } from './drivers/duckdb'
