import { createDefinition } from 'std:plugin'

import { LEVEL } from '../../const'

import { transportContext } from '../base'

export const write = createDefinition(({ use }) => {
  const transportCtx = use(transportContext)

  return (..._args: unknown[]) => {
    if (transportCtx.disabled || transportCtx.level > LEVEL.INFO) {
      return false
    }

    return true
  }
}).key('write')
