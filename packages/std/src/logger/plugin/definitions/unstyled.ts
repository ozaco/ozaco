import { createDefinition } from 'std:plugin'

import { context } from '../base'

export const unstyled = createDefinition(({ use }) => {
  const ctx = use(context)

  return (cb: (...args: unknown[]) => void, ...args: unknown[]) => {
    if (ctx.disabled) {
      return
    }

    cb(...args)
  }
})
