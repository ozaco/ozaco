// oxlint-disable unicorn/no-hex-escape
import { operation, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import { LoggerTransport } from '../definitions'
import { toJson } from '../internal/serialize'
import type { Helpers } from '../types/helpers'
import { LogLevel } from '../utils/level'
import { registerTransport, unregisterTransport } from '../utils/register'

interface ConsoleTransportOptions {
  level?: LogLevel | undefined
  pretty?: boolean | undefined
  color?: boolean | undefined
  msgKey?: string | undefined
  errorKey?: string | undefined
  format?: ((entry: Helpers.LogEntry) => string) | undefined
}

interface ConsoleTransportContext {
  name: string
  format: (entry: Helpers.LogEntry) => AnyType

  options: ConsoleTransportOptions
}

const ANSI = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  gray: '\x1B[90m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  cyan: '\x1B[36m',
  magenta: '\x1B[35m',
} as const

const paint = (enabled: boolean, color: string, text: string): string =>
  enabled ? `${color}${text}${ANSI.reset}` : text

const detectColor = (): boolean => {
  if (typeof process === 'undefined') {
    return false
  }
  const env = process.env
  if (env.NO_COLOR) {
    return false
  }
  if (env.FORCE_COLOR) {
    return true
  }
  return Boolean(process.stdout && process.stdout.isTTY)
}

const labelOf = (level: LogLevel): string => {
  if (level >= LogLevel.fatal) {
    return 'FATAL'
  }
  if (level >= LogLevel.error) {
    return 'ERROR'
  }
  if (level >= LogLevel.warn) {
    return 'WARN '
  }
  if (level >= LogLevel.info) {
    return 'INFO '
  }
  if (level >= LogLevel.debug) {
    return 'DEBUG'
  }
  return 'TRACE'
}

const colorOf = (level: LogLevel): string => {
  if (level >= LogLevel.fatal) {
    return `${ANSI.bold}${ANSI.magenta}`
  }
  if (level >= LogLevel.error) {
    return ANSI.red
  }
  if (level >= LogLevel.warn) {
    return ANSI.yellow
  }
  if (level >= LogLevel.info) {
    return ANSI.green
  }
  if (level >= LogLevel.debug) {
    return ANSI.cyan
  }
  return ANSI.gray
}

const formatBindings = (bindings: Record<string, unknown>, color: boolean): string => {
  const keys = Object.keys(bindings)
  if (keys.length === 0) {
    return ''
  }
  const parts = keys.map(k => {
    const key = paint(color, ANSI.cyan, k)
    return `${key}=${JSON.stringify(bindings[k])}`
  })
  return ` ${parts.join(' ')}`
}

const prettyFormat = (entry: Helpers.LogEntry, color: boolean): string => {
  const time = paint(color, ANSI.dim, `[${new Date(entry.time).toISOString()}]`)
  const label = paint(color, colorOf(entry.level), labelOf(entry.level))
  const bindings = formatBindings(entry.bindings, color)
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : ''
  const error = entry.error
    ? ` ${paint(color, ANSI.red, `err=${JSON.stringify(entry.error)}`)}`
    : ''
  return `${time} ${label}${bindings}: ${entry.msg}${data}${error}`
}

const ConsoleTransportImpl = LoggerTransport.implement<
  ConsoleTransportContext,
  unknown,
  [options?: ConsoleTransportOptions]
>({
  name: 'console-transport',
  version: '0.0.1',

  *setup(options = {}) {
    const name = 'console'
    const transport = ConsoleTransport as AnyType

    yield* registerTransport({ name, level: options.level, transport })

    const pretty = options.pretty ?? true
    const color = options.color ?? detectColor()
    const msgKey = options.msgKey ?? 'msg'
    const errorKey = options.errorKey ?? 'err'

    return {
      name,
      format:
        options.format ??
        (pretty ? entry => prettyFormat(entry, color) : entry => toJson(entry, msgKey, errorKey)),
      options,
    }
  },
})

const write = operation(function* (entry: Helpers.LogEntry) {
  const ctx = yield* useContext(ConsoleTransportImpl.context)
  const text = ctx.format(entry)

  if (entry.level >= LogLevel.error) {
    console.error(text)
  } else if (entry.level >= LogLevel.warn) {
    console.warn(text)
  } else if (entry.level >= LogLevel.info) {
    console.info(text)
  } else {
    console.debug(text)
  }
})

const flush = operation(function* () {})

const close = operation(function* () {
  const ctx = yield* useContext(ConsoleTransportImpl.context)

  yield* unregisterTransport(ctx.name)
})

export const ConsoleTransport = ConsoleTransportImpl.build({
  write,
  flush,
  close,
})
