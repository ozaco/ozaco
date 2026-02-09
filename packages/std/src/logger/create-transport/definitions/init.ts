import { createDefinition } from 'std:plugin'

import type { TransportOptions } from '../../type'

import { transportContext } from '../base'

export const initDefinition = createDefinition(({ use }) => {
  const transportCtx = use(transportContext)

  return (options?: TransportOptions) => {
    transportCtx.level = options?.level ?? transportCtx.level
    transportCtx.disabled = options?.disabled ?? transportCtx.disabled

    transportCtx.logger = options?.logger ?? transportCtx.logger
  }
})
