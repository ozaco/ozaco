import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { type LEVEL, loggerContext } from 'std:logger'
import {
  flushDefinition,
  initDefinition,
  transportContext,
  triggerDefinition,
  writeDefinition,
} from 'std:logger:create-transport'

import type { FileTransportContext, FileTransportOptions } from './types'

export const init = initDefinition
  .extend(({ def, use }) => {
    return (options?: FileTransportOptions) => {
      const ctx = use(transportContext as unknown as FileTransportContext)

      ctx.path = options?.path ?? ctx.path ?? `.ozaco/logs/latest.log`

      mkdirSync(dirname(ctx.path), {
        recursive: true,
      })

      ctx.queue ??= []
      ctx.draining ??= false

      ctx.limit = options?.limit ?? ctx.limit ?? 1000
      ctx.highWaterMark = options?.highWaterMark ?? ctx.highWaterMark ?? 64 * 1024

      ctx.stream =
        options?.stream ??
        ctx.stream ??
        createWriteStream(ctx.path, {
          flags: 'a',
          autoClose: true,
          highWaterMark: ctx.highWaterMark,
        })

      if (options?.platform && ctx.platformInfo === undefined) {
        if (typeof process !== 'undefined') {
          ctx.platformInfo = `${process.ppid ?? '-'}/${process.pid}@${process.platform}-${process.arch}`
        } else if (typeof window !== 'undefined') {
          ctx.platformInfo = `browser@${window.navigator.userAgent}`
        } else {
          ctx.platformInfo = 'unknown'
        }
      }

      return def(options)
    }
  })
  .key('setOptions')

export const write = writeDefinition.extend(({ use }) => {
  const ctx = use(transportContext as unknown as FileTransportContext)

  return (level: LEVEL, ...args: unknown[]) => {
    const loggerCtx = ctx.logger.get(loggerContext)

    if (ctx.disabled || (ctx.level ?? loggerCtx.level) > level) return false

    ctx.queue.push(
      `{"date":"${loggerCtx.date?.() ?? ''}","scope":"${loggerCtx.scope ?? ''}","level":"${level}","message":${JSON.stringify(args)}${
        ctx.platformInfo ? `,"platform":"${ctx.platformInfo}"` : ''
      }}\n`,
    )

    return true
  }
})

export const trigger = triggerDefinition.extend(({ use }) => {
  const ctx = use(transportContext as unknown as FileTransportContext)

  // ok will always be true no need to check it
  return (_ok: boolean) => !ctx.draining
})

export const flush = flushDefinition.extend(({ use }) => {
  const ctx = use(transportContext as unknown as FileTransportContext)

  const flushInternal = (): boolean => {
    if (ctx.draining || ctx.queue.length === 0) {
      return false
    }

    ctx.draining = true

    while (ctx.queue.length > 0) {
      const chunk = ctx.queue.shift()!
      const ok = ctx.stream.write(chunk)

      if (!ok) {
        ctx.stream.once('drain', () => {
          ctx.draining = false

          flushInternal()
        })
        return false
      }
    }

    ctx.draining = false
    return true
  }

  return flushInternal
})
