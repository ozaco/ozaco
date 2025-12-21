import { createExtendable } from 'std:plugin'

import { optionsContext } from './contexts'

import { logDebug } from './definitions/debug'
import { init } from './definitions/init'

export const extendable = createExtendable({
  namespace: 'cli',
  name: 'logger',
}).define(optionsContext, init.key('setOptions'), logDebug.key('debug'))
