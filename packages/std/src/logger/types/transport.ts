import type { Operation } from 'std:effect'
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
    write(entry: LoggerDef.Entry): Operation<void>
    flush(): Operation<void>
    close(): Operation<void>
  }
}
