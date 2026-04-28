import { operation, useContext } from 'std:effect'
import { IO, IO_FLAGS } from 'std:io'
import type { AnyType } from 'std:shared'

import { LoggerTransport } from '../definitions'
import { toNdjson } from '../internal/serialize'
import type { Helpers } from '../types/helpers'
import type { LogLevel } from '../utils/level'
import { registerTransport, unregisterTransport } from '../utils/register'

const encoder = new TextEncoder()

interface FileTransportOptions {
  path: string
  level?: LogLevel | undefined
  msgKey?: string | undefined
  errorKey?: string | undefined
  ensureDir?: boolean | undefined
  bufferSize?: number | undefined
  format?: ((entry: Helpers.LogEntry) => string) | undefined
}

interface FileTransportContext {
  name: string
  buffer: string[]
  limit: number
  format: (entry: Helpers.LogEntry) => AnyType

  options: FileTransportOptions
}

const FileTransportImpl = LoggerTransport.implement<
  FileTransportContext,
  unknown,
  [options: FileTransportOptions]
>({
  name: 'file-transport',
  version: '0.0.1',

  *setup(options) {
    const name = `file:${options.path}`
    const transport = FileTransport as AnyType

    yield* registerTransport({ name, level: options.level, transport })

    if (options.ensureDir ?? true) {
      yield* IO.actions.ensureDir(options.path.split('/').slice(-1).join('/'))
    }
    yield* IO.actions.ensureFile(options.path)

    return {
      name,
      buffer: [],
      limit: Math.max(0, options.bufferSize ?? 0),
      format:
        options.format ??
        (entry => toNdjson(entry, options.msgKey ?? 'msg', options.errorKey ?? 'err')),

      options,
    }
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

const write = operation(function* (entry: Helpers.LogEntry) {
  const ctx = yield* useContext(FileTransportImpl.context)

  ctx.buffer.push(ctx.format(entry))
  if (ctx.buffer.length > ctx.limit) {
    yield* drain()
  }
})

const close = operation(function* () {
  const ctx = yield* useContext(FileTransportImpl.context)

  yield* drain()
  yield* unregisterTransport(ctx.name)
})

export const FileTransport = FileTransportImpl.build({
  write,
  flush: drain,
  close,
})
