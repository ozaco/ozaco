import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { loggerContext } from 'std:logger'
import { init as initDefinition, transportContext, write as writeDefinition } from 'std:logger:create-transport'

import type { FileTransportContext, FileTransportOptions } from './types'

export const init = initDefinition
  .extend(({ def, use }) => {
    return (options?: FileTransportOptions) => {
      const ctx = use(transportContext as unknown as FileTransportContext)

      ctx.path = options?.path ?? ctx.path ?? `.ozaco/logs/${Date.now()}.log`

      const dir = dirname(ctx.path)

      if (!existsSync(dir)) {
        mkdirSync(dir, {
          recursive: true,
        })
      }

      ctx.stream =
        options?.stream ??
        ctx.stream ??
        createWriteStream(ctx.path, {
          autoClose: true,
          flags: 'a+',
          highWaterMark: 16 * 1024, // 16KB
          flush: true,
        })

      return def(options)
    }
  })
  .key('setOptions')

export const write = writeDefinition.extend(({ def, use }) => {
  const ctx = use(transportContext as unknown as FileTransportContext)

  return (...args: unknown[]) => {
    const result = def(...args)
    const loggerCtx = ctx.logger?.get(loggerContext)

    if (result) {
      const object = {
        date: loggerCtx?.date?.() ?? null,
        scope: loggerCtx?.scope ?? null,
        level: ctx.level,
        message: args,
      }

      ctx.stream?.write(`${JSON.stringify(object)}\n`)
    }

    return result
  }
})
