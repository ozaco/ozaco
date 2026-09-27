import { createTags } from 'std:shared'

import { isDriverKind } from './internal/driver'

/**
 * The database error taxonomy — every failure surfaced by the `Db` plugin or a `DbAdapter` impl is a
 * Result failure carrying one of these tags (nothing throws). The constraint / `conflict` /
 * `connection` / `query` tags carry the matchers that recognize a DRIVER error (its SQLSTATE, its
 * `SQLITE_*` code, else its text): an adapter folds its driver's rejection with
 * `asFailure(error, DbErrors, driverCause(error))`, so the app never sees a driver shape — the
 * driver's message is the failure's, the driver error its `raw`.
 *
 * - `validation` — a write value or query referenced an unknown table/column or failed the schema
 * - `not-found` / `data-integrity` — result-shape errors from `unique()` and friends
 * - `unique` / `foreign-key` / `not-null` / `check` — constraint violations (SQLSTATE `23505` /
 *   `23503` / `23502` / `23514`, `SQLITE_CONSTRAINT_UNIQUE` / `_PRIMARYKEY` / `_FOREIGNKEY` /
 *   `_NOTNULL` / `_CHECK`)
 * - `conflict` — a retryable serialization/deadlock/busy failure (`transaction` retries on it;
 *   `40001` / `40P01`, `SQLITE_BUSY` / `SQLITE_LOCKED`)
 * - `connection` — establishing/using the backend connection failed (`08…`, `57P01`–`57P03`)
 * - `unsupported` — the installed adapter lacks the capability (`transaction`, `raw`, …)
 * - `configuration` — bad install wiring (e.g. no adapter installed before `DbClient`)
 * - `migration` — a schema reconcile step failed
 * - `cursor` — a pagination cursor could not be decoded
 * - `query` — generic backend failure with no more specific classification (its matcher is the
 *   catch-all: a foreign value folded with `DbErrors` is a backend failure, never
 *   `std:result.unknown`)
 */
export const DbErrors = createTags(
  'db',

  'validation',
  'not-found',
  'data-integrity',
  ['unique', isDriverKind('unique')],
  ['foreign-key', isDriverKind('foreign-key')],
  ['not-null', isDriverKind('not-null')],
  ['check', isDriverKind('check')],
  ['conflict', isDriverKind('conflict')],
  ['connection', isDriverKind('connection')],
  'unsupported',
  'configuration',
  'migration',
  'cursor',
  ['query', isDriverKind('query')],
)

/**
 * The Kv store error taxonomy — what a `Kv` impl (memory, redis, …) surfaces; every failure is a
 * Result failure carrying one of these tags.
 *
 * - `connection` — the backend could not be reached / answered with a transport error
 * - `encoding` — a value could not be encoded or decoded through the installed codec
 * - `unsupported` — the installed store lacks the capability (`atomic` increments, `keys` scans…)
 * - `configuration` — bad install wiring (invalid prefix, no codec, …)
 */
export const KvErrors = createTags('kv', 'connection', 'encoding', 'unsupported', 'configuration')
