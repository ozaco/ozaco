import { type ColorPlugin, colorsPlugin } from 'std:color'
import { createContext, createDependencyList } from 'std:plugin'

import { LEVEL } from '../const'
import type { Context } from '../type'

export const context = createContext<Context>({
  scope: null,
  disabled: false,
  level: LEVEL.INFO,

  stream: process.stdout,
})

export const dependencies = createDependencyList<{
  colors: ColorPlugin
}>({
  colors: colorsPlugin,
})
