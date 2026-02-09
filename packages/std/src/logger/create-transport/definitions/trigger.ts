import { createDefinition } from 'std:plugin'

export const triggerDefinition = createDefinition(() => {
  return (writeOk: boolean): boolean => !writeOk
}).key('trigger')
