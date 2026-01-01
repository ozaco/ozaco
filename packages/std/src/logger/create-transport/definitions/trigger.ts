import { createDefinition } from 'std:plugin'

export const trigger = createDefinition(() => {
  return (writeOk: boolean): boolean => !writeOk
}).key('trigger')
