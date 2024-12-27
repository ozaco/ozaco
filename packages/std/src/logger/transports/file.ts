import { join } from 'node:path'

import { loggerTags } from '../tag'
import { createTransport } from '../utils/transport'

import { $appendSync } from '../../io'
import { capsule } from '../../results'

export const createFileTransport = capsule(
  async ({ dir = join(process.cwd(), '.ozaco/logs') }: Std.Logger.FileTransportOptions = {}) => {
    const today = new Date().setHours(0, 0, 0, 0)
    const path = join(dir, `${+today}.log`)

    return createTransport(message => {
      $appendSync(path, `${JSON.stringify(message)}\n`).unwrap()
    }, loggerTags.get('file-transport'))
  },
  loggerTags.get('file-transport')
)
