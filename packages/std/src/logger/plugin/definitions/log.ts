import { LEVEL } from '../../const'

import { context, dependencies } from '../base'

import { unstyled } from './unstyled'

export const log = unstyled.extend(({ def, use }) => {
  const ctx = use(context)
  const deps = use(dependencies)

  const colors = deps['std#colors'].api
  const traceText = colors.text.gray('TRACE')
  const debugText = colors.text.gray('DEBUG')

  return {
    trace: def.bind(null, (...args: unknown[]) => {
      if (ctx.level > LEVEL.TRACE) {
        return
      }

      const scope = ctx.getScope()

      args.unshift(scope ? `${scope} ${traceText}` : traceText)

      console.debug.apply(null, args)
    }),

    debug: def.bind(null, (...args: unknown[]) => {
      if (ctx.level > LEVEL.DEBUG) {
        return
      }

      const scope = ctx.getScope()

      args.unshift(scope ? `${scope} ${debugText}` : debugText)

      console.debug.apply(null, args)
    }),
  }
})
