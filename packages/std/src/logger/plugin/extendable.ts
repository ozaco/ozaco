import { createExtendable } from 'std:plugin'

import { loggerContext, loggerDependencies } from './base'
import { init } from './definitions/init'
import { log } from './definitions/log'
import { unstyled } from './definitions/unstyled'

export const extendable = createExtendable({
  namespace: 'cli',
  name: 'logger',
}).define(
  loggerContext,
  loggerDependencies,

  init.key('setOptions'),
  unstyled.key('unstyled'),

  log,
)
