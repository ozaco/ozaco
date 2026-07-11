import { defineProtocol } from 'std:plugin'

import type { DBActions, DBContext } from './types/db'

export const DB = defineProtocol<DBContext, [unknown], DBActions>({
  name: 'db',
  version: '0.0.1',
  subtype: Symbol.for('@ozaco/db.protocol'),
})
