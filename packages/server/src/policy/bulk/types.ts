import type { PolicyDef } from 'server:core'
import type { Helpers } from 'std:effect'

export const BulkPolicyKey = 'bulk' as const

export namespace Bulk {
  export interface Options extends PolicyDef.Options {
    maxConcurrent?: number
    maxQueue?: number
    queueTimeout?: number
  }

  export interface Waiter {
    resolvers: Helpers.WithResolvers<void>
    timer?: ReturnType<typeof setTimeout>
    /** Set when the parked caller is halted: it removes itself from the queue, and `release` skips it
     * so a freed slot is never handed to a dead waiter (which would never balance the inflight count). */
    cancelled?: boolean
  }

  export interface Context extends PolicyDef.Context {
    maxConcurrent: number
    maxQueue: number
    queueTimeout: number
    inflight: number
    queue: Waiter[]
  }
}
