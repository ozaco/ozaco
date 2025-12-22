import { createDefinition } from 'std:plugin'

import type { Options } from '../../type'

import { context, dependencies } from '../base'

export const init = createDefinition(({ use }) => {
  const ctx = use(context)

  return (options?: Options) => {
    ctx.stream = options?.stream ?? ctx.stream
    ctx.disabled = options?.disabled ?? ctx.disabled
    ctx.level = options?.level ?? ctx.level
    ctx.noColors = options?.noColors ?? ctx.noColors

    const deps = use(dependencies)
    const colors = deps['std#colors'].api

    colors.setOptions({
      enabled: !ctx.noColors,
    })

    if (options?.scope) {
      ctx.scope = colors.style.bold(colors.text.gray(`[${colors.text.gray(options.scope)}]`))
    }
  }
})
