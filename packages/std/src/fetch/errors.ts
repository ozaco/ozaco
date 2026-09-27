import { createTags } from 'std:shared'

import { networkFault } from './internal/network'

/**
 * The fetch failure tags. `timeout` (a `TimeoutError` — the request's deadline) and `network` (a
 * transport fault, see `networkFault`) also say which platform rejection they stand for: a
 * rejected platform fetch is folded into them, the platform error kept as the failure's `raw`.
 */
export const FetchErrors = createTags(
  'std:fetch',

  ['timeout', { name: 'TimeoutError' }],
  'http-status',
  'parse',
  ['network', networkFault],
)
