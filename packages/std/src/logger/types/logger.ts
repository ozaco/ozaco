import type { Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { LogLevel } from '../const'

import type { LoggerTransportDef } from './transport'

export type LoggerDef = Plugin<
  LoggerDef.Context,
  unknown,
  [options?: LoggerDef.Options],
  LoggerDef.Actions
>

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
    unknown,
    [],
    LoggerTransportDef.Actions
  >

  export interface Actions {
    log(level: LogLevel, ...args: Payload[]): Future<void, unknown>

    trace(...args: Payload[]): Future<void, unknown>
    debug(...args: Payload[]): Future<void, unknown>
    info(...args: Payload[]): Future<void, unknown>
    warn(...args: Payload[]): Future<void, unknown>
    error(...args: Payload[]): Future<void, unknown>
    fatal(...args: Payload[]): Future<void, unknown>

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
}
