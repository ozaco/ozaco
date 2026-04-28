import type { Future, Operation } from 'std:effect'

import type { LogLevel } from '../utils/level'

import type { Helpers } from './helpers'

export interface LoggerContext {
  level: LogLevel

  msgKey: string
  errorKey: string
  bindings: Record<string, unknown>
  timestamp: () => number
}

export interface LoggerActions {
  log(level: LogLevel, ...args: Helpers.LogPayload[]): Future<void, unknown>

  trace(...args: Helpers.LogPayload[]): Future<void, unknown>
  debug(...args: Helpers.LogPayload[]): Future<void, unknown>
  info(...args: Helpers.LogPayload[]): Future<void, unknown>
  warn(...args: Helpers.LogPayload[]): Future<void, unknown>
  error(...args: Helpers.LogPayload[]): Future<void, unknown>
  fatal(...args: Helpers.LogPayload[]): Future<void, unknown>

  child<R, E = unknown>(
    bindings: Record<string, unknown>,
    fn: () => Operation<R, E>,
  ): Future<R, E | unknown>

  bind(bindings: Record<string, unknown>): Future<void, unknown>
  setLevel(level: LogLevel): Future<void, unknown>
  isLevelEnabled(level: LogLevel): Future<boolean, unknown>

  flush(): Future<void, unknown>
  close(): Future<void, unknown>
}
