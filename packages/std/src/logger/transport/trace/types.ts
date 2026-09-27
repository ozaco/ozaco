import type { LogLevel } from '../../const'

export namespace TraceTransportDef {
  export interface Options {
    /** The lowest level forwarded; default: the Logger's level at install (`trace` when no Logger
     * is installed yet — the Logger's own threshold still applies first). */
    level?: LogLevel | undefined
  }

  export interface Context {
    name: string
    level: LogLevel

    options: Options
  }
}
