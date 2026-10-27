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
    /** Create the missing parent directories at setup (default `true`); `false` fails setup with
     * `std:logger.configuration` when the directory is not there. */
    ensureDir?: boolean | undefined
    /**
     * Number of formatted records to hold in memory before one appending write drains them all.
     * Default `0`: buffering off, every record is appended to the file immediately. `flush` and
     * `close` drain whatever is pending regardless of the threshold.
     */
    bufferSize?: number | undefined
    format?: ((entry: LoggerDef.Entry) => Operation<string>) | undefined
    /** chmod the file to this mode at setup and after every rotation (`0o600`: the owner's
     * alone). */
    mode?: number | undefined
    /** Rotate once a write would take the file past `maxBytes`: `<path>` becomes `<path>.1`
     * (the older ones shift up to `<path>.<keep>`, default `keep` 1) and a fresh file starts. */
    rotate?: { readonly maxBytes: number; readonly keep?: number | undefined } | undefined
  }

  export interface Context {
    name: string
    level: LogLevel

    buffer: string[]
    limit: number
    /** bytes in the current file — what `rotate` counts against. */
    size: number
    format: (entry: LoggerDef.Entry) => Operation<AnyType>
    options: Options
  }
}
