/**
 * `server:policy/bulk` — the bulkhead layer: caps concurrent dispatches per action, queues the
 * overflow FIFO with a bounded queue and a queue timeout, and never leaks a permit on failure.
 */
export * from './definition'
export type * from './types'
