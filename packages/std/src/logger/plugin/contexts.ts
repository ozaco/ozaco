import { createContext } from 'std:plugin'
import type { Expand } from 'std:shared'

import { LEVEL } from '../const'
import type { Options } from '../type'

export const optionsContext = createContext<Expand<Required<Options>>>({
  scope: null,
  plain: false,
  disabled: false,
  level: LEVEL.INFO,

  stream: process.stdout,
})
