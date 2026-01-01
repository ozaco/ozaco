import { createDefinition } from 'std:plugin'

export const flush = createDefinition(() => {
  return (): boolean => true
}).key('flush')
