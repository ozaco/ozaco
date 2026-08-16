import type { Operation } from 'std:effect'

import type { OutcomeState, TraceOrigin } from './trace'

/** Cold row/spec shapes of the metrics store protocol (types-only namespace). */
export namespace MetricsStoreDef {
  /** One completed dispatch — the full correlation spine is mandatory (requirement 18). */
  export interface CallRecord {
    readonly ts: number
    readonly service: string
    readonly action: string
    readonly status: 'success' | 'failure'
    readonly durationMs: number
    readonly requestId: string
    readonly serviceId: string
    /** Rendered lane, e.g. `gw>todos>ai`. */
    readonly laneId: string
    readonly actionId: string
    readonly parentActionId?: string | undefined
    readonly outcome: OutcomeState | 'unknown'
    readonly delivered: boolean
    readonly origin: TraceOrigin
    readonly transport: string
    readonly error?: string | undefined
    /** JsonCodec-serialized cause chain on failures. */
    readonly causes?: string | undefined
    readonly meta?: string | undefined
  }

  export interface LogRecord {
    readonly ts: number
    readonly level: number
    readonly msg: string
    readonly requestId?: string | undefined
    readonly serviceId?: string | undefined
    readonly actionId?: string | undefined
    readonly error?: string | undefined
    readonly meta?: string | undefined
  }

  export interface EventRecord {
    readonly ts: number
    readonly name: string
    readonly value?: number | undefined
    readonly meta?: string | undefined
  }

  export type Row = Record<string, unknown>

  export interface Column {
    readonly name: string
    readonly kind: 'text' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json'
  }

  export interface DefineSpec {
    readonly table: string
    readonly columns: readonly Column[]
  }

  /** Structured, store-portable query (works on memory AND sql-backed stores). */
  export interface QuerySpec {
    readonly table: string
    /** Field → exact value equality match. */
    readonly where?: Record<string, unknown> | undefined
    readonly sinceMs?: number | undefined
    readonly untilMs?: number | undefined
    readonly orderBy?: string | undefined
    readonly direction?: 'asc' | 'desc' | undefined
    readonly limit?: number | undefined
  }

  export interface PruneSpec {
    readonly table: string
    readonly olderThanMs: number
  }
}

/**
 * The pluggable analytics store (impls: memory, starrocks; clickhouse planned). Row-model — no
 * counters/histograms in-process, aggregation is deferred to the store at read time.
 */
export interface MetricsStoreActions {
  init(): Operation<void>
  insert(table: string, rows: readonly MetricsStoreDef.Row[]): Operation<void>
  query(spec: MetricsStoreDef.QuerySpec): Operation<readonly MetricsStoreDef.Row[]>
  /** Raw SQL escape hatch — SQL-backed stores only (memory fails `unsupported`). */
  sql(statement: string, params?: readonly unknown[]): Operation<readonly MetricsStoreDef.Row[]>
  define(spec: MetricsStoreDef.DefineSpec): Operation<void>
  prune(spec: MetricsStoreDef.PruneSpec): Operation<number>
  close(): Operation<void>
}
