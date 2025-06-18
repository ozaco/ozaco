import picocolors from 'picocolors'

import type { BlobType } from '../../../shared'

import { LOGGER_LEVELS } from '../../consts'

import { loggerPluginBase } from '../base'
import { contextAction } from './context'

export const apiAction = loggerPluginBase.direct('api', ctx => {
  const context = ctx.$peek(contextAction).unwrap()

  // Trace
  const traceMark = picocolors.italic(' trace ')
  const traceNoConsole = context.options.levelIndex > LOGGER_LEVELS.indexOf('trace')

  // Debug
  const debugMark = picocolors.bgBlackBright(' debug ')
  const debugNoConsole = context.options.levelIndex > LOGGER_LEVELS.indexOf('debug')

  // Log
  const logMark = picocolors.bgCyan(' log ')
  const logNoConsole = context.options.levelIndex > LOGGER_LEVELS.indexOf('log')

  // Info
  const infoMark = picocolors.bgBlue(' info ')
  const infoNoConsole = context.options.levelIndex > LOGGER_LEVELS.indexOf('info')

  // Success
  const successMark = picocolors.bgGreen(' success ')
  const successNoConsole = context.options.levelIndex > LOGGER_LEVELS.indexOf('success')

  // Warn
  const warnMark = picocolors.bgYellow(' warn ')
  const warnNoConsole = context.options.levelIndex > LOGGER_LEVELS.indexOf('warn')

  // Err
  const errMark = picocolors.bgRed(' err ')
  const errNoConsole = context.options.levelIndex > LOGGER_LEVELS.indexOf('err')

  return ctx.apply({
    trace: ctx.$capsule('trace', (...args: BlobType[]) => {
      const [dateMark, date] = context.date

      context.callTransports({
        level: 'trace',
        messages: args,
        date,
        noConsole: traceNoConsole,
      })

      if (traceNoConsole) {
        return
      }

      // biome-ignore lint/suspicious/noConsole: Redundant
      console.log('%s%s', context.name, traceMark, ...args, dateMark)
    }),

    debug: ctx.$capsule('debug', (...args: BlobType[]) => {
      const [dateMark, date] = context.date

      context.callTransports({
        level: 'debug',
        messages: args,
        date,
        noConsole: debugNoConsole,
      })

      if (debugNoConsole) {
        return
      }

      // biome-ignore lint/suspicious/noConsole: Redundant
      console.debug('%s%s', context.name, debugMark, ...args, dateMark)
    }),

    log: ctx.$capsule('log', (...args: BlobType[]) => {
      const [dateMark, date] = context.date

      context.callTransports({
        level: 'log',
        messages: args,
        date,
        noConsole: logNoConsole,
      })

      if (logNoConsole) {
        return
      }

      // biome-ignore lint/suspicious/noConsole: Redundant
      console.debug('%s%s', context.name, logMark, ...args, dateMark)
    }),

    info: ctx.$capsule('info', (...args: BlobType[]) => {
      const [dateMark, date] = context.date

      context.callTransports({
        level: 'info',
        messages: args,
        date,
        noConsole: infoNoConsole,
      })

      if (infoNoConsole) {
        return
      }

      // biome-ignore lint/suspicious/noConsole: Redundant
      console.debug('%s%s', context.name, infoMark, ...args, dateMark)
    }),

    success: ctx.$capsule('success', (...args: BlobType[]) => {
      const [dateMark, date] = context.date

      context.callTransports({
        level: 'success',
        messages: args,
        date,
        noConsole: successNoConsole,
      })

      if (successNoConsole) {
        return
      }

      // biome-ignore lint/suspicious/noConsole: Redundant
      console.debug('%s%s', context.name, successMark, ...args, dateMark)
    }),

    warn: ctx.$capsule('warn', (...args: BlobType[]) => {
      const [dateMark, date] = context.date

      context.callTransports({
        level: 'warn',
        messages: args,
        date,
        noConsole: warnNoConsole,
      })

      if (warnNoConsole) {
        return
      }

      // biome-ignore lint/suspicious/noConsole: Redundant
      console.debug('%s%s', context.name, warnMark, ...args, dateMark)
    }),

    err: ctx.$capsule('err', (...args: BlobType[]) => {
      const [dateMark, date] = context.date

      context.callTransports({
        level: 'err',
        messages: args,
        date,
        noConsole: errNoConsole,
      })

      if (errNoConsole) {
        return
      }

      // biome-ignore lint/suspicious/noConsole: Redundant
      console.debug('%s%s', context.name, errMark, ...args, dateMark)
    }),
  })
})
