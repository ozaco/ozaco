import { createExtendable } from 'std:plugin'

import { handleDefinition } from './definitions/handle'
import { initDefinition } from './definitions/init'
import { pathDefinition } from './definitions/path'

export const extendableIO = createExtendable({
  namespace: 'io',
  version: '0.0.0',
}).define(handleDefinition, pathDefinition, initDefinition)
