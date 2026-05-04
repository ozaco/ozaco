import type { Operation } from 'std:effect'
import { all, operation, useContext } from 'std:effect'

import { Logger } from './definitions'
import { buildEntry } from './internal/build-entry'
import { dispatch } from './internal/dispatch'
import { logAt } from './internal/log-at'
import type { Helpers } from './types/helpers'
import type { LoggerContext } from './types/logger'
import { LogLevel } from './utils/level'
import { getTransports } from './utils/register'

const DefaultLoggerImpl = Logger.implement<
  LoggerContext,
  unknown,
  [options?: Helpers.LoggerOptions]
>({
  name: 'default-logger',
  version: '0.0.1',
  description: 'logger; reads transports from the LoggerTransport registry',

  *setup(options = {}) {
    const level = options.level ?? LogLevel.info

    return {
      level,
      // oxlint-disable-next-line oxc/no-rest-spread-properties
      bindings: options.bindings ? { ...options.bindings } : {},
      timestamp: options.timestamp ?? Date.now,
      errorKey: options.errorKey ?? 'err',
      msgKey: options.msgKey ?? 'msg',
    }
  },
})

const logAction = operation(function* (level: LogLevel, ...args: Helpers.LogPayload[]) {
  const ctx = yield* useContext(Logger)
  if (level < ctx.level) {
    return
  }
  const entry = buildEntry(ctx, level, args)
  yield* dispatch(entry)
})

const traceAction = logAt(LogLevel.trace)
const debugAction = logAt(LogLevel.debug)
const infoAction = logAt(LogLevel.info)
const warnAction = logAt(LogLevel.warn)
const errorAction = logAt(LogLevel.error)
const fatalAction = logAt(LogLevel.fatal)

const flushAction = operation(function* () {
  const transports = yield* getTransports()
  const ops = transports.map(t => t.transport.actions.flush())
  if (ops.length === 0) {
    return
  }
  yield* all(ops)
})

const bindAction = operation(function* (bindings: Record<string, unknown>) {
  const ctx = yield* useContext(Logger)

  Object.assign(ctx.bindings, bindings)
})

const childAction = operation(function* <R, E>(
  bindings: Record<string, unknown>,
  fn: () => Operation<R, E>,
) {
  const ctx = yield* useContext(Logger)
  const previous = ctx.bindings
  // oxlint-disable-next-line prefer-object-spread
  ctx.bindings = Object.assign({}, previous, bindings)
  try {
    return yield* fn()
  } finally {
    ctx.bindings = previous
  }
})

const setLevelAction = operation(function* (level: LogLevel) {
  const ctx = yield* useContext(Logger)
  ctx.level = level
})

const isLevelEnabledAction = operation(function* (level: LogLevel) {
  const ctx = yield* useContext(Logger)

  return level >= ctx.level
})

const closeAction = operation(function* () {
  const transports = yield* getTransports()
  const ops = transports.map(t => t.transport.actions.close())
  if (ops.length === 0) {
    return
  }
  yield* all(ops)
})

export const DefaultLogger = DefaultLoggerImpl.build({
  log: logAction,
  trace: traceAction,
  debug: debugAction,
  info: infoAction,
  warn: warnAction,
  error: errorAction,
  fatal: fatalAction,
  child: childAction,
  bind: bindAction,
  setLevel: setLevelAction,
  isLevelEnabled: isLevelEnabledAction,
  flush: flushAction,
  close: closeAction,
})
