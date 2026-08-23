import { column, table } from 'db:core'

import { OBSERVE_PREFIX } from '../const'

/** The outcome table `DbOutcomes` writes — hidden under the observe prefix, no change log.
 * Declare it on the app's `DbClient` before installing `DbOutcomes`. */
export const outcomesTable = table(
  `${OBSERVE_PREFIX}outcomes`,
  {
    cid: column.text(),
    state: column.enumOf('fulfilled', 'failed', 'cancelled'),
    serviceId: column.text(),
    actionId: column.text(),
    error: column.text().optional(),
    ts: column.int(),
  },
  { log: false },
).unique('by_cid', ['cid'])
