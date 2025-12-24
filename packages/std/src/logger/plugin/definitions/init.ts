import { createDefinition } from 'std:plugin'

import type { Options } from '../../type'

import { context, dependencies } from '../base'

export const init = createDefinition(({ use }) => {
  const ctx = use(context)

  return (options?: Options) => {
    ctx.level = options?.level ?? ctx.level
    ctx.stream = options?.stream ?? ctx.stream
    ctx.disabled = options?.disabled ?? ctx.disabled

    if (options?.scope) {
      const colors = use(dependencies).colors.api

      ctx.scope = () => colors.style.bold(colors.text.gray(`[${colors.text.gray(options.scope)}]`))
    }
  }
})
