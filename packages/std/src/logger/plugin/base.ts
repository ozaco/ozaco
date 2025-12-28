import { type ColorPlugin, colorsPlugin } from 'std:color'
import { createContext, createDependencyList } from 'std:plugin'

import { LEVEL } from '../const'
import type { AnyTransport, Context } from '../type'

export const loggerContext = createContext<Context>({
  scope: null,
  disabled: false,
  noConsole: false,
  level: LEVEL.INFO,
  date: () => new Date().toISOString(),

  getScope: null,
  getDate: null,
})

export const loggerDependencies = createDependencyList<{
  colors: ColorPlugin
  transports: AnyTransport[]
}>({
  colors: colorsPlugin,
  transports: [],
})
