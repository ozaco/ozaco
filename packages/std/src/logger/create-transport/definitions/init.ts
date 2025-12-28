import { createDefinition } from 'std:plugin'

import { context } from '../../plugin/base'

import type { TransportOptions } from '../../type'
import { transportContext } from '../base'

export const init = createDefinition(({ use }) => {
  const transportCtx = use(transportContext)

  return (options?: TransportOptions) => {
    transportCtx.level = options?.level ?? transportCtx.level
    transportCtx.disabled = options?.disabled ?? transportCtx.disabled

    transportCtx.logger = options?.logger?.get(context) ?? transportCtx.logger
  }
})
