import type { Operation } from 'std:effect'
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
    /**
     * Number of formatted records to hold in memory before one appending write drains them all.
     * Default `0`: buffering off, every record is appended to the file immediately. `flush` and
     * `close` drain whatever is pending regardless of the threshold.
     */
    bufferSize?: number | undefined
    format?: ((entry: LoggerDef.Entry) => Operation<string>) | undefined
  }

  export interface Context {
    name: string
    level: LogLevel

    buffer: string[]
    limit: number
    format: (entry: LoggerDef.Entry) => Operation<AnyType>
    options: Options
  }
}
