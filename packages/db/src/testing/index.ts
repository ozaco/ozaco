/**
 * `@ozaco/db/testing` — the adapter CONFORMANCE suite. An adapter (first- or third-party) is
 * conformant when `runAdapterSuite({ label, enabled, raw, use })` passes under `bun test`:
 * writes, queries (filters incl. json paths, order, skip, both paginations, aggregates),
 * upserts, imports, the reactive plane, transactions, the change log and the management plane,
 * every test on freshly dropped + re-migrated fixture tables.
 *
 * This subpath imports `bun:test` — it is for test files only; nothing else in the package
 * pulls it in.
 */
export { posts, schema, users } from './fixtures'
export { runAdapterSuite } from './suite'

export type * from './types'
