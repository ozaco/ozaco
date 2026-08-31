/** The demo's public surface: build a node (`createDemo`), walk it with the typed client
 * (`walk`), the service list, the schema and the pinned constants. Entrypoints live under
 * `scripts/` — `main.ts` (monolith), `cluster.ts`, `openobserve.ts`, `client.ts`. */
export {
  ACCESS_TTL_MS,
  APP_NAME,
  APP_VERSION,
  AUTH_SECRET,
  HOSTNAME,
  READY_TIMEOUT_MS,
  services,
  TRANSPORT_PREFIX,
} from './const'
export * from './errors'
export type * from './types/demo'
export { createDemo } from './utils/demo'
export { schema, todosTable, uploadChunksTable, uploadsTable, usersTable } from './utils/tables'
export { walk } from './utils/walk'
