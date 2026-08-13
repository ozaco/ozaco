import { createTags } from 'std:shared'

/**
 * The database error taxonomy — every failure surfaced by the `Db` plugin or a `DbAdapter` impl is a
 * Result failure carrying one of these tags (nothing throws). Adapters classify their backend's
 * native errors into these tags (SQLSTATE, SQLITE_* codes, …) so the app never sees a driver shape.
 *
 * - `validation` — a write value or query referenced an unknown table/column or failed the schema
 * - `not-found` / `data-integrity` — result-shape errors from `unique()` and friends
 * - `unique` / `foreign-key` / `not-null` / `check` — constraint violations
 * - `conflict` — a retryable serialization/deadlock/busy failure (`transaction` retries on it)
 * - `connection` — establishing/using the backend connection failed
 * - `unsupported` — the installed adapter lacks the capability (`transaction`, `raw`, …)
 * - `configuration` — bad install wiring (e.g. no adapter installed before `DbClient`)
 * - `migration` — a schema reconcile step failed
 * - `cursor` — a pagination cursor could not be decoded
 * - `query` — generic backend failure with no more specific classification
 */
export const DbErrors = createTags(
  'db',
  'validation',
  'not-found',
  'data-integrity',
  'unique',
  'foreign-key',
  'not-null',
  'check',
  'conflict',
  'connection',
  'unsupported',
  'configuration',
  'migration',
  'cursor',
  'query',
)
