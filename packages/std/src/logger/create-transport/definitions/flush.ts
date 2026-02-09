import { createDefinition } from 'std:plugin'

export const flushDefinition = createDefinition(() => {
  return (): boolean => true
}).key('flush')
