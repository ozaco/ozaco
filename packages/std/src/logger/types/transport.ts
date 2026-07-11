import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { LogLevel } from '../const'

import type { LoggerDef } from './logger'

export type LoggerTransportDef = Plugin<
  LoggerTransportDef.Context,
  unknown[],
  LoggerTransportDef.Actions
>

export namespace LoggerTransportDef {
  export interface Context {
    name: string
    level: LogLevel
  }

  export interface Actions {
    write(entry: LoggerDef.Entry): Future<void>
    flush(): Future<void>
    close(): Future<void>
  }
}
