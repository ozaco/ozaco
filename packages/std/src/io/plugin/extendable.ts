import { createExtendable } from 'std:plugin'

import { handle } from './definitions/handle'
import { path } from './definitions/path'

export const extendableIO = createExtendable({
  namespace: 'io',
  version: '0.0.0',
}).define(handle, path)
