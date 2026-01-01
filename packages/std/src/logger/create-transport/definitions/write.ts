import { createDefinition } from 'std:plugin'

import type { LEVEL } from '../../const'

export const write = createDefinition(() => {
  return (_level: LEVEL, ..._args: unknown[]): boolean => true
}).key('write')
