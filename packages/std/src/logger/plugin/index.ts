import { createPlugin } from 'std:plugin'

import { LEVEL } from '../const'

import { conditional } from './definitions/conditional'
import { init } from './definitions/init'
import { extendable } from './extendable'

export const createLogger = createPlugin(
  extendable.define(conditional.key('if')),
  {
    version: '0.0.0',
  },
  init,
)

export const loggerPlugin = createLogger({
  level: LEVEL.INFO,
})

export const {api: logger} = loggerPlugin