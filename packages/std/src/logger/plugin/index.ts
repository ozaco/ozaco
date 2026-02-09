import { createPlugin } from 'std:plugin'

import { LEVEL } from '../const'
import { extendable } from './extendable'
import { conditionalImplementation } from './internal/conditional'
import { initImplementation } from './internal/init'

export const createLogger = createPlugin(
  extendable.define(conditionalImplementation),
  {
    version: '0.0.0',
  },
  initImplementation,
)

export const loggerPlugin = createLogger({
  level: LEVEL.INFO,
})

export const { api: logger } = loggerPlugin

export * from './base'
