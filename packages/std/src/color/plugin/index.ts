import { createPlugin } from 'std:plugin'

import { extendable } from './extendable'
import { initImplementation } from './internal/init'

export const createColors = createPlugin(
  extendable,
  {
    version: '0.0.0',
  },
  initImplementation,
)

export const colorsPlugin = createColors()
export const { api: colors } = colorsPlugin
