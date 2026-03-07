import { createDefinition } from 'std:plugin'
import { isArray, isBoolean, isFunction } from 'std:shared'

import { transportContext } from '../../create-transport'
import type { Options } from '../../type'
import { isTransport } from '../../utils'

import { loggerContext, loggerDependencies } from '../base'

export const initImplementation = createDefinition(({ use, rebind }) => {
  rebind('transports', ({ plugin, dependency }) => {
    const transports = isArray(dependency) ? dependency : [dependency]

    for (const transport of transports) {
      if (!isTransport(transport)) {
        continue
      }

      transport.get(transportContext).logger = plugin
    }
  })

  const ctx = use(loggerContext)

  return (options?: Options) => {
    ctx.level = options?.level ?? ctx.level
    ctx.disabled = options?.disabled ?? ctx.disabled
    ctx.noConsole = options?.noConsole ?? ctx.noConsole

    ctx.scope = options?.scope ?? ctx.scope
    ctx.date = isBoolean(options?.date)
      ? options.date
        ? () => new Date().toISOString()
        : null
      : (options?.date ?? ctx.date)

    if (isBoolean(options?.date)) {
      ctx.getDate = options.date ? () => new Date().toISOString() : null
    } else if (isFunction(options?.date)) {
      ctx.getDate = options.date
    }

    if (ctx?.scope) {
      const colors = use(loggerDependencies).colors.api

      ctx.getScope = () => colors.style.bold(colors.text.gray(`[${colors.text.gray(ctx.scope)}]`))
    }
  }
})
