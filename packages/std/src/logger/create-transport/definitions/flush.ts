import { createDefinition } from 'std:plugin'

import { transportContext } from '../base'

export const flush = createDefinition(({ use }) => {
  const transportCtx = use(transportContext)

  return () => {
    if (transportCtx.disabled) {
      return false
    }

    return true
  }
}).key('flush')
