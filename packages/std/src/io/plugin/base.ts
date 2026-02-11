import { createContext } from 'std:plugin'

import type { Context } from '../types'

export const ioContext = createContext<Context>({
  runtime: null,
  autoPerm: true,
})
