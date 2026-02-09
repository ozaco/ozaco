import { createExtendable } from 'std:plugin'

import { transportContext } from './base'

import { flushDefinition } from './definitions/flush'
import { initDefinition } from './definitions/init'
import { triggerDefinition } from './definitions/trigger'
import { writeDefinition } from './definitions/write'

export const baseTransport = createExtendable({
  namespace: 'cli/logger',
}).define(transportContext, writeDefinition, flushDefinition, triggerDefinition)

export const extendableTransport = baseTransport.define(initDefinition.key('setOptions'))
