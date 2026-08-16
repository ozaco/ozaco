import type { MetricsStoreDef } from 'server:core'
import type { BoundLogger } from 'server:utils'
import type { Operation } from 'std:effect'
import type { LogLevel } from 'std:logger'
import type { AnyType } from 'std:shared'

import type { CallEvent } from 'server:policy/metrics'

import type { MetricsTableName } from './const'

/** `install(Metrics, options)` — every field optional. */
export interface MetricsOptions {
  /** Buffer drain period; a final flush always runs on scope teardown. Default `1000`. */
  readonly flushIntervalMs?: number | undefined
  /** Install the {@link MetricsLogTransport} so log entries land in the `logs` table. Default `true`. */
  readonly captureLogs?: boolean | undefined
  /** Level floor for captured log entries. Default `LogLevel.warn`. */
  readonly logLevel?: LogLevel | undefined
  /** Extra `meta` derivation per call row — serialized with the pinned JSON codec at flush time. */
  readonly fields?: ((event: CallEvent) => Record<string, string> | undefined) | undefined
}

/**
 * Anything with a protocol hook surface can be observed — Broker, Transport, a DbAdapter, any std
 * protocol handle. Each listed action is wrapped with a timing `around` hook that lands a
 * `${name}.${action}` row in the `events` table.
 */
export interface ObserveTarget {
  readonly api: { around(handlers: AnyType): Operation<void> }
  readonly name: string
  readonly actions: readonly string[]
}

/** Collector plumbing types — grouped (`Result.Failure` pattern); reach them as `MetricsDef.X`. */
export namespace MetricsDef {
  export interface ResolvedOptions {
    readonly flushIntervalMs: number
    readonly captureLogs: boolean
    readonly logLevel: LogLevel
    readonly fields: ((event: CallEvent) => Record<string, string> | undefined) | undefined
  }

  /**
   * The scope-bound collector buffers. Call events stay raw (`CallEvent`, causes as `string[]`) —
   * serialization happens at flush time, never in the sync sink path.
   */
  export interface Buffers {
    readonly calls: CallEvent[]
    readonly logs: MetricsStoreDef.LogRecord[]
    readonly events: MetricsStoreDef.EventRecord[]
  }

  /** The collector state — created per install by `setup`, NEVER module-global. */
  export interface State {
    readonly options: ResolvedOptions
    readonly buffers: Buffers
    readonly log: BoundLogger
    /** Consecutive insert failures per table — `log.error` fires once per streak, then debug. */
    readonly insertFailures: Record<MetricsTableName, number>
  }

  export interface LogTransportOptions {
    /** Entries below this level are ignored. Default `LogLevel.warn`. */
    readonly level?: LogLevel | undefined
  }

  export interface LogTransportContext {
    name: string
    level: LogLevel
  }
}
