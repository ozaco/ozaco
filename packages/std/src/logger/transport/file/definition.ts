import { operation, useContext } from 'std:effect'
import { IO, IO_FLAGS } from 'std:io'

import { LogLevel } from '../../const'
import { Logger, LoggerTransport } from '../../definitions'
import { toNdjson } from '../../internal/serialize'
import type { LoggerDef } from '../../types/logger'

import { encoder, getTranport } from './internal'
import type { FileDef } from './types'

const FileTransportImpl = LoggerTransport.implement<
  FileDef.Context,
  unknown,
  [options: FileDef.Options]
>({
  name: 'file-transport',
  version: '0.0.1',

  *setup(options) {
    const name = `file:${options.path}`

    if (options.ensureDir ?? true) {
      yield* IO.actions.ensureDir(options.path.split('/').slice(-1).join('/'))
    }
    yield* IO.actions.ensureFile(options.path)

    const context: FileDef.Context = {
      name,
      level: options.level ?? LogLevel.info,

      buffer: [],
      limit: Math.max(0, options.bufferSize ?? 0),
      format:
        options.format ??
        (entry => toNdjson(entry, options.msgKey ?? 'msg', options.errorKey ?? 'err')),

      options,
    }

    yield* Logger.actions.register(getTranport(), context)

    return context
  },
})

const drain = operation(function* () {
  const ctx = yield* useContext(FileTransportImpl.context)

  if (ctx.buffer.length === 0) {
    return
  }
  const payload = ctx.buffer.join('')
  ctx.buffer.length = 0

  yield* IO.actions.write(ctx.options.path, encoder.encode(payload), { flags: IO_FLAGS.APPEND })
})

export const FileTransport = FileTransportImpl.build({
  write: operation(function* (entry: LoggerDef.Entry) {
    const ctx = yield* useContext(FileTransportImpl.context)

    ctx.buffer.push(ctx.format(entry))
    if (ctx.buffer.length > ctx.limit) {
      yield* drain()
    }
  }),

  flush: drain,

  close: operation(function* () {
    yield* drain()
    yield* Logger.actions.unregister(getTranport())
  }),
})
