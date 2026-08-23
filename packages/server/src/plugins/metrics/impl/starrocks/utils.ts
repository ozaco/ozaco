/** The DDL of the two tables (duplicate-key, partitioned by day) — run it once. */
export const starrocksDdl = (
  database: string,
  tables: { readonly requests?: string | null; readonly spans?: string | null } = {},
): string => {
  const requests = tables.requests === undefined ? 'ozaco_requests' : tables.requests
  const spans = tables.spans === undefined ? 'ozaco_spans' : tables.spans
  const out: string[] = []

  if (requests) {
    out.push(`CREATE TABLE IF NOT EXISTS \`${database}\`.\`${requests}\` (
  ts DATETIME NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  origin VARCHAR(16),
  service VARCHAR(128),
  action VARCHAR(128),
  edge VARCHAR(16),
  method VARCHAR(16),
  path VARCHAR(1024),
  status INT,
  duration_ms BIGINT,
  service_id VARCHAR(128),
  instance VARCHAR(128),
  error VARCHAR(1024)
) DUPLICATE KEY (ts, request_id)
PARTITION BY date_trunc('day', ts)
DISTRIBUTED BY HASH(request_id)
PROPERTIES ("replication_num" = "1");`)
  }

  if (spans) {
    out.push(`CREATE TABLE IF NOT EXISTS \`${database}\`.\`${spans}\` (
  ts DATETIME NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  span_id VARCHAR(32) NOT NULL,
  parent_span_id VARCHAR(32),
  kind VARCHAR(32),
  name VARCHAR(256),
  service_id VARCHAR(128),
  action VARCHAR(128),
  transport VARCHAR(32),
  duration_ms BIGINT,
  status VARCHAR(16),
  instance VARCHAR(128)
) DUPLICATE KEY (ts, request_id, span_id)
PARTITION BY date_trunc('day', ts)
DISTRIBUTED BY HASH(request_id)
PROPERTIES ("replication_num" = "1");`)
  }

  return out.join('\n\n')
}
