import { createDefinition } from 'std:plugin'

import type { LEVEL } from '../../const'

import { loggerContext, loggerDependencies } from '../base'

export type MethodImpl = () => string
export type CallbackImpl = (...args: unknown[]) => void

export const unstyled = createDefinition(({ use }) => {
  const ctx = use(loggerContext)
  const deps = use(loggerDependencies)

  return (cb: CallbackImpl, method: MethodImpl, level: LEVEL, ...args: unknown[]) => {
    if (ctx.disabled || ctx.level > level) {
      return
    }

    // TODO: transports
    for (const transport of deps.transports) {
      transport.api.write(...args)

      if (transport.api.trigger()) {
        transport.api.flush()
      }
    }

    if (ctx.noConsole) {
      return
    }

    args.unshift(method())

    cb.apply(null, args)
  }
})
