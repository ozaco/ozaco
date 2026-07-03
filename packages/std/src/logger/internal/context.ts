import { createContext, markContextAsSnapshot } from 'std:effect'

export const LoggerBindingsContext = markContextAsSnapshot(
  createContext<Record<string, unknown>>('std:logger:bindings', {}),
)
