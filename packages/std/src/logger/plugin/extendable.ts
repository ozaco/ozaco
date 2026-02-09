import { createExtendable } from 'std:plugin'

import { loggerContext, loggerDependencies } from './base'
import { initImplementation } from './internal/init'
import { logImplementation } from './internal/log'
import { unstyledImplementation } from './internal/unstyled'

export const extendable = createExtendable({
  namespace: 'cli',
  name: 'logger',
}).define(
  loggerContext,
  loggerDependencies,

  initImplementation.key('setOptions'),
  unstyledImplementation.key('unstyled'),

  logImplementation,
)
