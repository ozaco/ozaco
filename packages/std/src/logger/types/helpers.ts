import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { LogLevel } from '../utils/level'

import type { LoggerContext } from './logger'
import type { LoggerTransportActions } from './transport'

export namespace Helpers {
  export type LoggerOptions = Partial<LoggerContext>

  export type LogPayload =
    | string
    | Record<string, unknown>
    | Result<unknown, unknown>
    | undefined
    | null

  export interface LogEntry {
    level: LogLevel
    time: number
    msg: string
    error: string
    bindings: Record<string, unknown>
    data: Record<string, unknown> | undefined
  }

  export interface LoggerTransportEntry {
    name: string
    level?: LogLevel | undefined

    transport: AnyTransportPlugin<unknown>
  }

  export type AnyTransportPlugin<TContext = unknown> = Plugin<
    TContext,
    unknown,
    [],
    LoggerTransportActions
  >
}
