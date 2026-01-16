import type { LoggerPlugin } from 'std:logger'
import { createContext, createDependencyList } from 'std:plugin'
import type { Expand } from 'std:shared'

import type { Options } from '../type'

export const context = createContext<Expand<Required<Options>>>({
  runtime: true,
})

export const dependencies = createDependencyList<{
  logger?: LoggerPlugin | undefined
}>({
  logger: undefined,
})
