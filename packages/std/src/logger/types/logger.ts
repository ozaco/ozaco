import type { Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { LogLevel } from '../const'

import type { LoggerTransportDef } from './transport'

export type LoggerDef = Plugin<LoggerDef.Context, [options?: LoggerDef.Options], LoggerDef.Actions>

export namespace LoggerDef {
  export interface Options {
    level?: LogLevel
    bindings?: Record<string, unknown>
    msgKey?: string
    errorKey?: string
    timestamp?: () => number
  }

  export interface Context {
    level: LogLevel
    msgKey: string
    errorKey: string
    timestamp: () => number
  }

  export type Payload =
    | string
    | Record<string, unknown>
    | Result<unknown, unknown>
    | undefined
    | null

  export interface Entry {
    level: LogLevel
    time: number
    msg: string
    error: string
    bindings: Record<string, unknown>
    data: Record<string, unknown> | undefined
  }

  export interface TransportEntry {
    name: string
    level?: LogLevel | undefined
    transport: AnyTransportPlugin<unknown>
  }

  export type AnyTransportPlugin<TContext = unknown> = Plugin<
    TContext,
    [],
    LoggerTransportDef.Actions
  >

  export interface Actions {
    log(level: LogLevel, ...args: Payload[]): Future<void>

    trace(...args: Payload[]): Future<void>
    debug(...args: Payload[]): Future<void>
    info(...args: Payload[]): Future<void>
    warn(...args: Payload[]): Future<void>
    error(...args: Payload[]): Future<void>
    fatal(...args: Payload[]): Future<void>

    child<R>(bindings: Record<string, unknown>, fn: () => Operation<R>): Future<R>

    bind(bindings: Record<string, unknown>): Future<void>
    setLevel(level: LogLevel): Future<void>
    isLevelEnabled(level: LogLevel): Future<boolean>

    flush(): Future<void>
    close(): Future<void>
  }
}
