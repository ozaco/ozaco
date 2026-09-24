import { column, table } from 'db:core'

/**
 * Declare a job-queue table — add it to the `DbClient` schema and name it in
 * `Queue.use({ table })`: `defineSchema({ …, jobs: queueTable('jobs') })`. The dedupe key is a
 * unique index (what makes `enqueue(…, { dedupeKey })` race-free); `(state, run_at)` indexes
 * the claim.
 */
export const queueTable = <const TName extends string>(name: TName) =>
  table(name, {
    kind: column.text(),
    payload: column.json<unknown>().optional(),
    state: column.enumOf('queued', 'running', 'done', 'failed', 'dead').default('queued'),
    dedupe_key: column.text().optional(),
    priority: column.int().default(0),
    run_at: column.timestamp({ as: 'ms' }),
    attempts: column.int().default(0),
    max_attempts: column.int().optional(),
    lease_until: column.timestamp({ as: 'ms' }).optional(),
    worker: column.text().optional(),
    last_error: column.text().optional(),
    finished_at: column.timestamp({ as: 'ms' }).optional(),
  })
    .unique('by_dedupe', ['dedupe_key'])
    .index('by_ready', ['state', 'run_at'])
