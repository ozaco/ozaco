import { join } from 'node:path'

import { createPlugin } from '../../plugin'
import { $appendSync } from '../../io'

export const fileTransportBase = createPlugin({
  name: 'file-transport',
  version: '0.0.0',
  options: [] as Std.Logger.FileTransport.Options,
})

export const createFileTransport = fileTransportBase.register(
  fileTransportBase.direct('base', ctx => {
    const logDir = ctx.meta.options[0] ?? join(process.cwd(), '.ozaco/logs')

    const write = ctx.$capsule('write', (message: Std.Logger.Message) => {
      const today = new Date().setHours(0, 0, 0, 0)
      const path = join(logDir, `${+today}.log`)

      $appendSync(path, `${JSON.stringify(message)}\n`).unwrap()
    })

    return ctx.apply({
      write,
    })
  })
)
