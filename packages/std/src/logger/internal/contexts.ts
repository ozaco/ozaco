import { createContext } from 'std:effect'

import type { Helpers } from '../types/helpers'

export const LoggerTransportRegistryRef = createContext<Helpers.LoggerTransportEntry[]>(
  'std:logger:transport:registry',
  [],
)
