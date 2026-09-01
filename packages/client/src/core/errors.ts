import { createTags } from 'std:shared'

/**
 * Client-side failures. A server failure travels with its OWN tag (`server.not-found`,
 * `db.conflict`, `todo.kaput`, …) — these tags cover only what goes wrong before a reply exists.
 */
export const ClientErrors = createTags(
  'client',
  'configuration',
  'no-route',
  'network',
  'decode',
  'timeout',
  'closed',
  'refused',
)
