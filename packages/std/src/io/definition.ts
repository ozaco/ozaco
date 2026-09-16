import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

import type { IODef } from './types/io'

export const IO = defineProtocol<AnyType, IODef.Actions>({
  name: 'std/io',
  version: pkg.version,
})
