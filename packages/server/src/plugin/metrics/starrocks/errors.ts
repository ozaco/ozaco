import { createTags } from 'std:shared'

/**
 * StarRocks store failure tags:
 * - `ingest` — a Stream Load PUT failed (transport, redirect or a non-Success `Status`);
 * - `query` — a MySQL-protocol statement failed;
 * - `configuration` — unusable options or the optional `mysql2` peer is missing.
 */
export const StarRocksErrors = createTags(
  'server:metrics/starrocks',
  'ingest',
  'query',
  'configuration',
)
