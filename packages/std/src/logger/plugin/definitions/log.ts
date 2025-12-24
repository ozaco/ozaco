import { LEVEL } from '../../const'

import { context, dependencies } from '../base'

import { type MethodImpl, unstyled } from './unstyled'

export const log = unstyled.extend(({ def, use }) => {
  const ctx = use(context)
  const colors = use(dependencies).colors.api

  const buildText = (method: MethodImpl) => () => {
    const texts: string[] = []

    if (ctx.scope) {
      texts.push(ctx.scope())
    }

    if (ctx.date) {
      texts.push(colors.text.black(ctx.date()))
    }

    texts.push(method())

    return texts.join(' ')
  }

  const trace = buildText(() => colors.text.gray('TRACE'))
  const debug = buildText(() => colors.textBright.blue('DEBUG'))
  const info = buildText(() => colors.text.blue('INFO'))
  const success = buildText(() => colors.text.green('SUCCESS'))
  const warn = buildText(() => colors.text.yellow('WARN'))
  const error = buildText(() => colors.text.red('ERROR'))
  const fatal = buildText(() => colors.text.red('FATAL'))

  return {
    trace: def.bind(null, console.debug, trace, LEVEL.TRACE),
    debug: def.bind(null, console.debug, debug, LEVEL.DEBUG),
    info: def.bind(null, console.info, info, LEVEL.INFO),
    success: def.bind(null, console.log, success, LEVEL.SUCCESS),
    warn: def.bind(null, console.warn, warn, LEVEL.WARN),
    error: def.bind(null, console.error, error, LEVEL.ERROR),
    fatal: def.bind(null, console.error, fatal, LEVEL.FATAL),
  }
})
