import { column, defineSchema, table } from 'db:core'
import { queueTable } from 'db:queue'

/** The demo's tables: a crud resource (todos), users for auth, a log of uploads, the job queue. */
export const todosTable = table('todos', {
  title: column.text(),
  done: column.boolean().default(() => false),
  priority: column.enumOf('low', 'normal', 'high').default(() => 'normal'),
})

export const usersTable = table('users', {
  email: column.text(),
  name: column.text(),
  password: column.text(),
  roles: column.json(),
})

export const uploadsTable = table('uploads', {
  name: column.text(),
  size: column.int(),
  mime: column.text(),
})

/** File content, raw bytes per chunk row (`column.blob()`: sqlite BLOB, no base64 detour) —
 * written on upload, streamed back on download. */
export const uploadChunksTable = table('upload_chunks', {
  upload_id: column.text(),
  seq: column.int(),
  data: column.blob(),
})

/** The durable job queue (`@ozaco/db/queue`): one row per job — its state, attempts, the last
 * failure's whole chain and the trace context it was enqueued in. */
export const jobsTable = queueTable('jobs')

/** The ONE schema declaration: the install takes it, `useDb(schema)` resolves the typed
 * handle anywhere — no call site re-lists the tables. */
export const schema = defineSchema({
  todosTable,
  usersTable,
  uploadsTable,
  uploadChunksTable,
  jobsTable,
})
