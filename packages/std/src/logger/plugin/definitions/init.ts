import { createDefinition } from 'std:plugin'

import type { Options } from '../../type'

import { context, dependencies } from '../base'

export const init = createDefinition(({ use }) => {
  const ctx = use(context)

  return (options?: Options) => {
    ctx.stream = options?.stream ?? ctx.stream
    ctx.disabled = options?.disabled ?? ctx.disabled
    ctx.scope = options?.scope ?? ctx.scope
    ctx.level = options?.level ?? ctx.level
    ctx.noColors = options?.noColors ?? ctx.noColors

    const deps = use(dependencies)
    const colors = deps['std#colors'].api

    colors.setOptions({
      enabled: !ctx.noColors,
    })

    if (ctx.scope) {
      ctx.getScope = () => {
        return colors.text.gray(`[ ${ctx.scope} ]`)
      }
    }
  }
})
