import { createExtendable } from 'std:plugin'

import { handle } from './definitions/handle'
import { stats } from './definitions/stats'

export const extendableIO = createExtendable({
  namespace: 'io',
  version: '0.0.0',
}).define(handle, stats)
