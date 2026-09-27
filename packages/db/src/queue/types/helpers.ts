import type { AnyType } from 'std:shared'

import type { QueueDef } from './queue'

/** The shapes the queue passes around inside itself. */
export namespace Helpers {
  /** A job row as the worker reads it (payload untyped). */
  export type Row = QueueDef.Row<AnyType>

  /** A worker's resolved and checked options (`settingsOf`). */
  export interface Settings {
    readonly batch: number
    readonly backoff: QueueDef.Backoff
    readonly maxAttempts: number
    readonly pollMs: number
    readonly leaseMs: number
    readonly sweepMs: number
  }
}
