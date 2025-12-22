import { LEVEL } from '../../const'

import { context, dependencies } from '../base'

import { type CallbackImpl, type MethodImpl, unstyled } from './unstyled'

export const log = unstyled.extend(({ def, use }) => {
  const ctx = use(context)
  const deps = use(dependencies)

  const buildText = (method: string) => () => (ctx.scope ? `${ctx.scope} ${method}` : method)

  const colors = deps['std#colors'].api

  const trace = buildText(colors.text.gray('TRACE'))
  const debug = buildText(colors.textBright.blue('DEBUG'))
  const info = buildText(colors.text.blue('INFO'))
  const success = buildText(colors.text.green('SUCCESS'))
  const warn = buildText(colors.text.yellow('WARN'))
  const error = buildText(colors.text.red('ERROR'))
  const fatal = buildText(colors.text.red('FATAL'))

  const buildLogFn = (level: LEVEL, method: MethodImpl, cb: CallbackImpl) => {
    return def.bind(null, level, method, cb)
  }

  return {
    trace: buildLogFn(LEVEL.TRACE, trace, console.debug),
    debug: buildLogFn(LEVEL.DEBUG, debug, console.debug),
    info: buildLogFn(LEVEL.INFO, info, console.info),
    success: buildLogFn(LEVEL.SUCCESS, success, console.log),
    warn: buildLogFn(LEVEL.WARN, warn, console.warn),
    error: buildLogFn(LEVEL.ERROR, error, console.error),
    fatal: buildLogFn(LEVEL.FATAL, fatal, console.error),
  }
})
