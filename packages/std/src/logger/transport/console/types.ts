import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { LogLevel } from '../../const'
import type { LoggerDef } from '../../types/logger'

export namespace ConsoleDef {
  export interface Options {
    level?: LogLevel | undefined
    pretty?: boolean | undefined
    color?: boolean | undefined
    msgKey?: string | undefined
    errorKey?: string | undefined
    format?: ((entry: LoggerDef.Entry) => Operation<string>) | undefined
  }

  export interface Context {
    name: string
    level: LogLevel

    format: (entry: LoggerDef.Entry) => Operation<AnyType>
    options: Options
  }
}
