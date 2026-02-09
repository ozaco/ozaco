import { createDefinition } from 'std:plugin'

import type { LEVEL } from '../../const'

import { loggerContext, loggerDependencies } from '../base'

export type MethodImpl = () => string
export type CallbackImpl = (...args: unknown[]) => void

export const unstyledImplementation = createDefinition(({ use }) => {
  const ctx = use(loggerContext)
  const deps = use(loggerDependencies)

  return (cb: CallbackImpl, method: MethodImpl, level: LEVEL, ...args: unknown[]) => {
    if (ctx.disabled) {
      return
    }

    for (const transport of deps.transports ?? []) {
      const ok = transport.api.write(level, ...args)

      if (transport.api.trigger(ok)) {
        transport.api.flush()
      }
    }

    if (ctx.noConsole || ctx.level > level) {
      return
    }

    args.unshift(method())

    cb.apply(null, args)
  }
})
