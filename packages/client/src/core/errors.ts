import { createTags } from 'std:shared'

import { networkFault } from './internal/network'

/**
 * Client-side failures. A server failure travels with its OWN tag (`server.not-found`,
 * `db.conflict`, `todo.kaput`, …) — these tags cover only what goes wrong before a reply exists.
 * `network` also says which platform rejection it stands for (a transport fault, see
 * `networkFault`): a fetch that never produced a response is folded into it
 * (`asFailure(error, ClientErrors)`), the platform error kept as the failure's `raw`.
 */
export const ClientErrors = createTags(
  'client',
  'configuration',
  'no-route',
  ['network', networkFault],
  'decode',
  'timeout',
  'closed',
  'refused',
)
