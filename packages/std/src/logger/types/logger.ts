import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { LogLevel } from '../const'

export type LoggerDef = Plugin<LoggerDef.Context, [options?: LoggerDef.Options], LoggerDef.Actions>

export namespace LoggerDef {
  export interface Options {
    level?: LogLevel | undefined
    bindings?: Record<string, unknown> | undefined
    msgKey?: string | undefined
    /** The record key of the entry's error (default `err`); an object payload's `Error` / Failure
     * under this key (or `err` / `error`) is the entry's failure, not a data field. */
    errorKey?: string | undefined
    timestamp?: (() => number) | undefined
  }

  export interface Context {
    level: LogLevel
    msgKey: string
    errorKey: string
    timestamp: () => number
  }

  export type Payload =
    | string
    | Error
    | Record<string, unknown>
    | Result<unknown, unknown>
    | undefined
    | null

  /** The span an entry was logged in: W3C hex ids and trace flags. */
  export interface Trace {
    readonly traceId: string
    readonly spanId: string
    readonly flags: number
  }

  export interface Entry {
    level: LogLevel
    time: number
    msg: string
    /** `formatFailure(failures[0])` — the one-line form of the first failure; `''` without one. */
    error: string
    /**
     * Every failure the payload carried, in payload order: Failure / `Error` payloads (an `Error`
     * folded by `asFailure`, kept as its `raw`), an object payload's `err` / `error` / error-key value,
     * and the `Error`s / Failures nested deeper in object payloads (those also stay in `data`,
     * rendered by `formatFailure`).
     */
    failures: readonly Result.Failure<unknown>[]
    bindings: Record<string, unknown>
    data: Record<string, unknown> | undefined
    /** The active span when the entry was logged (recording, non-recording or a pass-through
     * inbound context); absent outside of any. */
    trace?: Trace
  }

  export interface Actions {
    log(level: LogLevel, ...args: Payload[]): Operation<void>

    trace(...args: Payload[]): Operation<void>
    debug(...args: Payload[]): Operation<void>
    info(...args: Payload[]): Operation<void>
    warn(...args: Payload[]): Operation<void>
    error(...args: Payload[]): Operation<void>
    fatal(...args: Payload[]): Operation<void>

    child<R>(bindings: Record<string, unknown>, fn: () => Operation<R>): Operation<R>

    bind(bindings: Record<string, unknown>): Operation<void>
    setLevel(level: LogLevel): Operation<void>
    isLevelEnabled(level: LogLevel): Operation<boolean>

    flush(): Operation<void>
    close(): Operation<void>
  }
}
