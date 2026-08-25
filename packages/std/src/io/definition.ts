import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

import type { IOActions } from './types/actions'

export const IO = defineProtocol<AnyType, IOActions>({
  name: 'io',
  version: pkg.version,
})
