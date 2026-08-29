import type { Operation } from 'std:effect'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface Waiter {
    granted: boolean
    abandoned: boolean
    grant(): void
    gate: Operation<void>
  }

  /** The arbitration state of ONE terminal's live region: a mutex plus a FIFO wait queue. */
  export interface LeaseState {
    busy: boolean
    waiters: Waiter[]
  }
}
