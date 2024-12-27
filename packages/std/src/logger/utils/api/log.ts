import picocolors from 'picocolors'

import { capsule } from '../../../results'
import type { BlobType } from '../../../shared'

import { loggerTags } from '../../tag'

export const createLog = (logger: Std.Logger.Api) => {
  const mark = picocolors.bgCyan(' log ')

  const handler = (...args: BlobType[]) => {
    const [dateMark, date] = logger.date

    logger.callTransports({
      level: 'log',
      messages: args,
      date,
    })

    if (logger.options.disableConsole) {
      return
    }

    // biome-ignore lint/suspicious/noConsole: Redundant
    console.log('%s%s', logger.name, mark, ...args, dateMark)
  }

  return capsule(handler, loggerTags.get('log'))
}
