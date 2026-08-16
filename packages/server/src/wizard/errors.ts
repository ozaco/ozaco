import { createTags } from 'std:shared'

/**
 * Wizard failure tags. Database failures pass through untouched with their own `db.*` tags — each
 * compiled action maps them to HTTP statuses via its typed `errors` field (`'db.validation': 400`,
 * `'db.conflict': 412`, `'db.unique': 409`, …).
 *
 * - `not-found` — a document addressed by id does not exist (mapped to 404 by the crud actions)
 * - `bad-filter` — the wire-supplied `filter` parameter is not valid JSON (mapped to 400)
 * - `bad-frame` — an inbound realtime frame failed `clientFrame` validation (error frame, no
 *   crash), or the SSE `args` query parameter is not valid JSON (mapped to 400)
 * - `not-watchable` — a `watch` frame named a fn that is neither a crud `list` nor a
 *   `query({ watch: true })`
 * - `bad-definition` — a definition-time misuse of the wizard api (an api entry that is neither a
 *   resource nor a service, a resource fn that is not a query/mutation/action declaration, a
 *   reserved fn key); thrown synchronously from the builders, never sent over the wire
 */
export const WizardErrors = createTags(
  'server:wizard',
  'not-found',
  'bad-filter',
  'bad-frame',
  'not-watchable',
  'bad-definition',
)
