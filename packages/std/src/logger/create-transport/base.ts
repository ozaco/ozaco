import { createContext } from 'std:plugin'

import { LEVEL } from '../const'
import type { TransportContext } from '../type'

export const transportContext = createContext<TransportContext>({
  logger: null,
  disabled: false,
  level: LEVEL.INFO,
})
