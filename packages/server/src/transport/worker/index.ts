/**
 * `server:transport/worker` — the worker-thread/port carrier: single wire envelopes over message
 * ports (structured clone, no byte codec). Host role spawns workers; child role attaches to the
 * parent port and serves its broker's registry.
 */
export * from './const'
export * from './definition'
export type * from './types'
