import type { AnyType } from 'std:shared'

import type { LogLevel } from '../../const'
import type { LoggerDef } from '../../types/logger'

export namespace FileDef {
  export interface Options {
    path: string
    level?: LogLevel | undefined
    msgKey?: string | undefined
    errorKey?: string | undefined
    ensureDir?: boolean | undefined
    bufferSize?: number | undefined
    format?: ((entry: LoggerDef.Entry) => string) | undefined
  }

  export interface Context {
    name: string
    level: LogLevel

    buffer: string[]
    limit: number
    format: (entry: LoggerDef.Entry) => AnyType
    options: Options
  }
}
