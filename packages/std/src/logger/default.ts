import type { Operation } from 'std:effect'
import { operation, useContext } from 'std:effect'

import pkg from '../../package.json'

import { LogLevel } from './const'
import { Logger, LoggerTransport } from './definitions'
import { LoggerBindingsContext } from './internal/context'
import { buildEntry, dispatch, logAt } from './internal/helpers'
import type { LoggerDef } from './types/logger'

export const DefaultLogger = Logger.implement({
  name: 'default-logger',
  version: pkg.version,
  description: 'logger; reads transports from the LoggerTransport registry',

  *setup(options: LoggerDef.Options = {}) {
    if (options.bindings) {
      yield* LoggerBindingsContext.set({ ...options.bindings })
    }

    return {
      level: options.level ?? LogLevel.info,
      timestamp: options.timestamp ?? Date.now,
      errorKey: options.errorKey ?? 'err',
      msgKey: options.msgKey ?? 'msg',
    }
  },
}).build({
  log: operation(function* (level: LogLevel, ...args: LoggerDef.Payload[]) {
    const ctx = yield* useContext(Logger)
    if (level < ctx.level) {
      return
    }
    const bindings = (yield* LoggerBindingsContext.get()) ?? {}
    const entry = buildEntry({ ctx, bindings }, level, args)
    yield* dispatch(entry)
  }),

  trace: logAt(LogLevel.trace),
  debug: logAt(LogLevel.debug),
  info: logAt(LogLevel.info),
  warn: logAt(LogLevel.warn),
  error: logAt(LogLevel.error),
  fatal: logAt(LogLevel.fatal),

  child: operation(function* <R>(bindings: Record<string, unknown>, fn: () => Operation<R>) {
    const previous = (yield* LoggerBindingsContext.get()) ?? {}
    return yield* LoggerBindingsContext.with({ ...previous, ...bindings }, () => fn())
  }),

  bind: operation(function* (bindings: Record<string, unknown>) {
    const previous = (yield* LoggerBindingsContext.get()) ?? {}
    yield* LoggerBindingsContext.set({ ...previous, ...bindings })
  }),

  setLevel: operation(function* (level: LogLevel) {
    const ctx = yield* useContext(Logger)
    ctx.level = level
  }),

  isLevelEnabled: operation(function* (level: LogLevel) {
    const ctx = yield* useContext(Logger)
    return level >= ctx.level
  }),

  flush: operation(function* () {
    yield* LoggerTransport.actions.flush()
  }),

  close: operation(function* () {
    yield* LoggerTransport.actions.close()
  }),
})
