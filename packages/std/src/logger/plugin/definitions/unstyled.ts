import { createDefinition } from 'std:plugin'

import type { LEVEL } from '../../const'

import { context } from '../base'

export type MethodImpl = () => string
export type CallbackImpl = (...args: unknown[]) => void

export const unstyled = createDefinition(({ use }) => {
  const ctx = use(context)

  return (cb: CallbackImpl, method: MethodImpl, level: LEVEL, ...args: unknown[]) => {
    if (ctx.disabled || ctx.level > level) {
      return
    }

    // TODO: transports

    if (ctx.noConsole) {
      return
    }

    args.unshift(method())

    cb.apply(null, args)
  }
})
