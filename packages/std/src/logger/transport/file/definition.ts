import { useContext } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import pkg from '../../../../package.json'
import { LogLevel } from '../../const'
import { LoggerTransport } from '../../definitions'
import { LoggerErrors } from '../../errors'
import { toNdjson } from '../../internal/serialize'
import type { LoggerDef } from '../../types/logger'

import { drain } from './internal'
import type { FileDef } from './types'

const FileTransportImpl = LoggerTransport.implement<FileDef.Context, [options: FileDef.Options]>({
  name: 'std/file-transport',
  version: pkg.version,

  *setup(options) {
    const name = `file:${options.path}`

    // `ensureDir` (default true) creates the missing parent directories; with it off a missing
    // directory is a configuration failure, not a silent mkdir
    if (options.ensureDir ?? true) {
      yield* IO.actions.ensureFile(options.path)
    } else if (!(yield* IO.actions.exists(yield* IO.actions.dirname(options.path)))) {
      return yield* fail(
        LoggerErrors.Configuration,
        `log directory does not exist: ${yield* IO.actions.dirname(options.path)} (ensureDir: false)`,
      )
    }

    const context: FileDef.Context = {
      name,
      level: options.level ?? LogLevel.trace,

      buffer: [],
      limit: Math.max(0, options.bufferSize ?? 0),
      format:
        options.format ??
        (entry => toNdjson(entry, options.msgKey ?? 'msg', options.errorKey ?? 'err')),

      options,
    }

    return context
  },
})

export const FileTransport = FileTransportImpl.build({
  *write(entry: LoggerDef.Entry) {
    const ctx = yield* useContext(FileTransportImpl.context)

    if (entry.level < ctx.level) {
      return
    }

    ctx.buffer.push(yield* ctx.format(entry))
    if (ctx.buffer.length >= ctx.limit) {
      yield* drain(ctx)
    }
  },

  *flush() {
    yield* drain(yield* useContext(FileTransportImpl.context))
  },

  *close() {
    yield* drain(yield* useContext(FileTransportImpl.context))
  },
})
