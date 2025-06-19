/// <reference path="../../shared/index.ts" />
/// <reference path="../../results/index.ts" />
/// <reference path="../../plugin/index.ts" />
/// <reference path="../index.ts" />

import { join } from 'node:path'
import process from 'node:process'
import { $appendSync } from '../../io'
import { createPlugin } from '../../plugin'

export const fileTransportBase = createPlugin({
  name: 'file-transport',
  options: [] as Std.Logger.FileTransport.Options,
  version: '0.0.0',
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
  }),
)
