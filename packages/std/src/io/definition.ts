import { defineNamespace } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { IO_VERSION } from './const'
import type { IOActions } from './types/actions'

export const IO = defineNamespace<AnyType, AnyType, [], IOActions>({
  name: 'io',
  version: IO_VERSION,
})
