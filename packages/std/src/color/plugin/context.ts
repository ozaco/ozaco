import { createContext } from 'std:plugin'
import type { Expand } from 'std:shared'

import { isColorSupported } from '../const'
import type { Options } from '../type'

export const optionsContext = createContext<Expand<Required<Options>>>({
  enabled: isColorSupported,
})
