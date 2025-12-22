import { createPlugin } from 'std:plugin'

import { init } from './definitions/init'

import { extendable } from './extendable'

export const createColors = createPlugin(
  extendable,
  {
    version: '0.0.0',
  },
  init,
)

export const { api: colors } = createColors()
