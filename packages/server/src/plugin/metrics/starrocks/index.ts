/**
 * `server:plugin/metrics/starrocks` — the StarRocks `MetricsStore`.
 *
 * Ingest: Stream Load over the FE HTTP API through the std `Fetch` plugin (the consumer installs
 * `FetchClient` + a JSON codec), following the FE→BE 307 redirect manually so `Authorization`
 * survives. Query/DDL/prune: the MySQL protocol via the OPTIONAL `mysql2` peer dependency.
 */
export * from './const'
export * from './definition'
export * from './errors'
export type * from './types'
