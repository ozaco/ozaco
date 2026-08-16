/**
 * `server:plugin/metrics` — the scope-bound metrics collector (plan §16).
 *
 * `install(Metrics)` (after a `MetricsStore` impl) plants the `MetricsSinkContext` consumed by the
 * observer policy, so EVERY dispatch lands in the `calls` table with the full correlation spine;
 * warn+ log entries are captured into `logs` via a `LoggerTransport` impl; `Metrics.actions.record`
 * and `Metrics.actions.observe` (generic protocol timing hooks) feed the `events` table. Buffers
 * flush on an interval and once more on scope teardown — at-most-once loss semantics.
 */
export * from './const'
export * from './definition'
export type * from './types'
