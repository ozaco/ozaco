// oxlint-disable unicorn/no-hex-escape

import type { Operation } from 'std:effect'
import { map } from 'std:effect'
import { formatFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { LogLevel } from '../../const'
import { visibleBindings } from '../../internal/serialize'
import type { LoggerDef } from '../../types/logger'

/** How much of the trace id the pretty line shows (`trace=<8 hex>`). */
export const TRACE_PREFIX = 8

/** The indent of a failure chain block under the pretty line. */
export const CHAIN_INDENT = '  '

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

/** ` trace=<first 8 hex of the trace id>` inside a span, else nothing. */
export const formatTrace = (trace: LoggerDef.Trace | undefined, color: boolean): string =>
  trace ? ` ${paint(color, ANSI.gray, `trace=${trace.traceId.slice(0, TRACE_PREFIX)}`)}` : ''

/** Failure chains (`formatFailure(f, { chain: true })`) as indented blocks below the pretty line. */
export const formatChains = (chains: readonly string[], color: boolean): string =>
  chains
    .flatMap(chain => chain.split('\n'))
    .map(line => `\n${CHAIN_INDENT}${paint(color, ANSI.red, line)}`)
    .join('')

/**
 * `[iso-time] LABEL bindings trace=<8>: msg data err="<one line>"`, then the failure chains
 * indented below it. Every failure prints ONCE: the first one as the line's `err=` when its chain
 * is one line, else as its chain block alone (causes, stack frames, `Caused by:` levels); every
 * further failure as its block. `trace=` is the span the entry was logged in (an exception record
 * forwarded to the Logger is logged in its own span's context).
 */
export const prettyFormat = function* (entry: LoggerDef.Entry, color: boolean): Operation<string> {
  const time = paint(color, ANSI.dim, `[${new Date(entry.time).toISOString()}]`)
  const label = paint(color, colorOf(entry.level), labelOf(entry.level))
  const bindings = yield* formatBindings(visibleBindings(entry.bindings), color)
  const trace = formatTrace(entry.trace, color)
  const data = entry.data ? ` ${yield* JsonCodec.actions.stringify(entry.data)}` : ''

  const [head, ...rest] = entry.failures
  const lead = head === undefined ? '' : formatFailure(head, { chain: true })
  const block = lead.includes('\n')
  const chains = [...(block ? [lead] : []), ...rest.map(f => formatFailure(f, { chain: true }))]

  const error =
    entry.error && !block
      ? ` ${paint(color, ANSI.red, `err=${yield* JsonCodec.actions.stringify(entry.error)}`)}`
      : ''

  return `${time} ${label}${bindings}${trace}: ${entry.msg}${data}${error}${formatChains(chains, color)}`
}
