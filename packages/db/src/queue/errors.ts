import { createTags } from 'std:shared'

/**
 * The job-queue error taxonomy (`db:queue.*`). Handler failures are NOT surfaced — they are
 * recorded on the job (`last_error`, a retry or the dead letter).
 *
 * - `configuration` — no `DbClient` installed, or the queue table is not declared in its schema
 * - `validation` — an `enqueue`/`work` argument is malformed (empty kind, bad options)
 */
export const QueueErrors = createTags('db:queue', 'configuration', 'validation')
