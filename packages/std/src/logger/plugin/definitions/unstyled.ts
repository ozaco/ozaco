import { createDefinition } from 'std:plugin'

import { optionsContext } from '../contexts'

export const unstyled = createDefinition(({ use }) => {
  const ctx = use(optionsContext)

  return (cb: (...args: unknown[]) => void, ...args: unknown[]) => {
    if (ctx.disabled) {
      return
    }

    if (ctx.plain) {
      console.log(...args)
      return
    }

    cb(...args)
  }
})
