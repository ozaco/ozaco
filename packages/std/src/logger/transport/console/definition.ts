import { useContext } from 'std:effect'

import pkg from '../../../../package.json'
import { LogLevel } from '../../const'
import { Logger, LoggerTransport } from '../../definitions'
import { toJson } from '../../internal/serialize'
import type { LoggerDef } from '../../types/logger'

import { detectColor, prettyFormat } from './internal'
import type { ConsoleDef } from './types'

const ConsoleTransportImpl = LoggerTransport.implement<
  ConsoleDef.Context,
  [options?: ConsoleDef.Options]
>({
  name: 'std/console-transport',
  version: pkg.version,

  /**
   * Must be installed AFTER the logger (`DefaultLogger` or another `Logger` impl): setup does
   * `useContext(Logger)` to inherit the logger's level as the default transport level, so installing
   * the transport first fails with `std:effect.missing-context`.
   */
  *setup(options = {}) {
    const name = 'console'

    const pretty = options.pretty ?? true
    const color = options.color ?? detectColor()
    const msgKey = options.msgKey ?? 'msg'
    const errorKey = options.errorKey ?? 'err'

    const loggerCtx = yield* useContext(Logger)

    const context: ConsoleDef.Context = {
      name,
      level: options.level ?? loggerCtx.level,
      format:
        options.format ??
        (pretty ? entry => prettyFormat(entry, color) : entry => toJson(entry, msgKey, errorKey)),
      options,
    }

    return context
  },
})

export const ConsoleTransport = ConsoleTransportImpl.build({
  *write(entry: LoggerDef.Entry) {
    const ctx = yield* useContext(ConsoleTransportImpl.context)

    if (entry.level < ctx.level) {
      return
    }

    const text = yield* ctx.format(entry)

    if (entry.level >= LogLevel.error) {
      console.error(text)
    } else if (entry.level >= LogLevel.warn) {
      console.warn(text)
    } else if (entry.level >= LogLevel.info) {
      console.info(text)
    } else {
      console.debug(text)
    }
  },

  *flush() {},
  *close() {},
})
