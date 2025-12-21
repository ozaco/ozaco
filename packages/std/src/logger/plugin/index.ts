import { createPlugin } from 'std:plugin'

import { init } from './definitions/init'

import { extendable } from './extendable'

export const createLogger = createPlugin(
  extendable,
  {
    version: '0.0.0',
  },
  init,
)

export type LoggerPlugin = ReturnType<typeof createLogger>
