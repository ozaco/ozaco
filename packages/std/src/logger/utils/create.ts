import picocolors from 'picocolors'

import { capsule } from '../../results'

import { LOGGER_LEVELS } from '../consts'
import { loggerTags } from '../tag'

import { createErr } from './api/err'
import { createLog } from './api/log'
import { createWarn } from './api/warn'

export const create = capsule((options: Std.Logger.Options) => {
  options.name = options.name.trim()
  options.transports = options.transports ?? []
  options.level = options.level ?? 'log'

  const logger = {
    options: {
      ...options,
      levelIndex: LOGGER_LEVELS.indexOf(options.level),
    },

    name: picocolors.bgBlack(picocolors.whiteBright(picocolors.bold(` ${options.name} `))),

    get date() {
      const date = new Date()

      const hour = `${date.getHours()}`.padStart(2, '0')
      const minute = `${date.getMinutes()}`.padStart(2, '0')
      const second = `${date.getSeconds()}`.padStart(2, '0')
      const millisecond = `${date.getMilliseconds()}`.padStart(3, '0')

      const day = `${date.getDate()}`.padStart(2, '0')
      const month = `${date.getMonth() + 1}`.padStart(2, '0')
      const year = `${date.getFullYear()}`

      return [
        picocolors.gray(`${hour}:${minute}:${second}.${millisecond} ${day}/${month}/${year}`),
        date,
      ]
    },
  } as Std.Logger.Api

  logger.callTransports = capsule(message => {
    for (const transport of logger.options.transports) {
      transport(message)
    }
  }, loggerTags.get('call-transports'))

  logger.log = createLog(logger)
  logger.err = createErr(logger)
  logger.warn = createWarn(logger)

  return Object.freeze(logger)
}, loggerTags.get('create'))
