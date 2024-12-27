import picocolors from 'picocolors'

import { capsule } from '../../../results'
import type { BlobType } from '../../../shared'

import { loggerTags } from '../../tag'

export const createWarn = (logger: Std.Logger.Api) => {
  const mark = picocolors.bgYellow(' warn ')

  const handler = (...args: BlobType[]) => {
    const [dateMark, date] = logger.date

    logger.callTransports({
      level: 'warn',
      messages: args,
      date,
    })

    if (logger.options.disableConsole) {
      return
    }

    // biome-ignore lint/suspicious/noConsole: Redundant
    console.warn('%s%s', logger.name, mark, ...args, dateMark)
  }

  return capsule(handler, loggerTags.get('warn'))
}
