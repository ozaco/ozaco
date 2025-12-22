import { type ColorPlugin, colorsPlugin } from 'std:color'
import { createContext, createDependencyList } from 'std:plugin'

import { LEVEL } from '../const'
import type { Context } from '../type'

export const context = createContext<Context>({
  scope: null,
  noColors: false,
  disabled: false,
  level: LEVEL.INFO,

  stream: process.stdout,

  getScope: () => null,
})

export const dependencies = createDependencyList<{
  'std#colors': ColorPlugin
}>({
  'std#colors': colorsPlugin,
})
