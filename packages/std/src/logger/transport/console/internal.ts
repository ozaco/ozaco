// oxlint-disable unicorn/no-hex-escape

import type { Operation } from 'std:effect'
import { map } from 'std:effect'

import { JsonCodec } from 'std:codec/impl/json'

import { LogLevel } from '../../const'
import type { LoggerDef } from '../../types/logger'

export const ANSI = {
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

export const paint = (enabled: boolean, color: string, text: string): string =>
  enabled ? `${color}${text}${ANSI.reset}` : text

export const detectColor = (): boolean => {
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

export const labelOf = (level: LogLevel): string => {
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

export const colorOf = (level: LogLevel): string => {
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

export const formatBindings = function* (
  bindings: Record<string, unknown>,
  color: boolean,
): Operation<string> {
  const keys = Object.keys(bindings)
  if (keys.length === 0) {
    return ''
  }
  const parts = yield* map(keys, function* (k) {
    const key = paint(color, ANSI.cyan, k)
    return `${key}=${yield* JsonCodec.actions.stringify(bindings[k])}`
  })
  return ` ${parts.join(' ')}`
}

export const prettyFormat = function* (entry: LoggerDef.Entry, color: boolean): Operation<string> {
  const time = paint(color, ANSI.dim, `[${new Date(entry.time).toISOString()}]`)
  const label = paint(color, colorOf(entry.level), labelOf(entry.level))
  const bindings = formatBindings(entry.bindings, color)
  const data = entry.data ? ` ${yield* JsonCodec.actions.stringify(entry.data)}` : ''
  const error = entry.error
    ? ` ${paint(color, ANSI.red, `err=${yield* JsonCodec.actions.stringify(entry.error)}`)}`
    : ''
  return `${time} ${label}${bindings}: ${entry.msg}${data}${error}`
}
