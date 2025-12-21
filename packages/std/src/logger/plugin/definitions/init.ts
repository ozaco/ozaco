import { createDefinition } from 'std:plugin'

import type { Options } from '../../type'

import { optionsContext } from '../contexts'

export const init = createDefinition(({ use }) => {
  const ctx = use(optionsContext)

  return (options?: Options) => {
    ctx.stream = options?.stream ?? ctx.stream
    ctx.disabled = options?.disabled ?? ctx.disabled
    ctx.scope = options?.scope ?? ctx.scope
    ctx.level = options?.level ?? ctx.level
    ctx.plain = options?.plain ?? ctx.plain
  }
})
