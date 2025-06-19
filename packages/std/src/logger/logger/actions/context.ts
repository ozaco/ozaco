import picocolors from 'picocolors'

import { LOGGER_LEVELS } from '../../consts'
import { loggerPluginBase } from '../base'

export const contextAction = loggerPluginBase.action('context', ctx => {
  const level = ctx.meta.options[1] ?? 'log'

  const options = {
    level,
    levelIndex: LOGGER_LEVELS.indexOf(level),
    name: ctx.meta.options[0].trim(),
  }

  const name = picocolors.bgBlack(picocolors.whiteBright(picocolors.bold(` ${options.name} `)))

  return ctx.apply({
    callTransports: ctx.$capsule('call-transports', (message: Std.Logger.Message) => {
      const dependencyNames = Object.keys(ctx.dependencies) as unknown as (keyof typeof ctx.dependencies)[]

      for (const dependencyName of dependencyNames) {
        const transport = ctx.dependencies[dependencyName]

        if (transport) {
          transport.write(message)
        }
      }
    }),

    get date() {
      const date = new Date()

      const hour = `${date.getHours()}`.padStart(2, '0')
      const minute = `${date.getMinutes()}`.padStart(2, '0')
      const second = `${date.getSeconds()}`.padStart(2, '0')
      const millisecond = `${date.getMilliseconds()}`.padStart(3, '0')

      const day = `${date.getDate()}`.padStart(2, '0')
      const month = `${date.getMonth() + 1}`.padStart(2, '0')
      const year = `${date.getFullYear()}`

      return [picocolors.gray(`${hour}:${minute}:${second}.${millisecond} ${day}/${month}/${year}`), date] as const
    },
    name,
    options,
  })
})
