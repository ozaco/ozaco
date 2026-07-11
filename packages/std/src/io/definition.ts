import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { IOActions } from './types/actions'

export const IO = defineProtocol<AnyType, [], IOActions>({
  name: 'io',
  version: '0.0.1',
})
