import { createDefinition } from 'std:plugin'
import { isBoolean, isFunction } from 'std:shared'

import type { Options } from '../../type'

import { context, dependencies } from '../base'

export const init = createDefinition(({ use }) => {
  const ctx = use(context)

  return (options?: Options) => {
    ctx.level = options?.level ?? ctx.level
    ctx.disabled = options?.disabled ?? ctx.disabled
    ctx.noConsole = options?.noConsole ?? ctx.noConsole

    ctx.scope = options?.scope ?? ctx.scope
    ctx.date = options?.date ?? ctx.date

    if (isBoolean(options?.date)) {
      ctx.getDate = options.date ? () => new Date().toISOString() : null
    } else if (isFunction(options?.date)) {
      ctx.getDate = options.date
    }

    if (ctx?.scope) {
      const colors = use(dependencies).colors.api

      ctx.getScope = () => colors.style.bold(colors.text.gray(`[${colors.text.gray(ctx.scope)}]`))
    }
  }
})
