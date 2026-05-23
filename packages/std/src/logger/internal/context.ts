import { createContext, markContextAsSnapshot } from 'std:effect'

import type { LoggerTransportDef } from '../types/transport'

export const LoggerTransportRegistryContext = createContext<LoggerTransportDef[]>(
  'std:logger:transport:registry',
  [],
)

export const LoggerBindingsContext = markContextAsSnapshot(
  createContext<Record<string, unknown>>('std:logger:bindings', {}),
)
